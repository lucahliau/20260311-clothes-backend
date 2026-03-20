/**
 * Diagnose PostgreSQL ClothingItem vs R2 nobg URLs (feed requires active + hasNobg=true).
 * Run: npx tsx scripts/diagnose-nobg-feed.ts [--limit N] [--full] [--no-http] [--examples N]
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { getNobgUrl } from "../src/lib/images.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

type UrlBucket = "r2_full_url" | "products_path_only" | "other_host";

function parseArgs() {
  const argv = process.argv.slice(2);
  let limit = 20;
  let full = false;
  let noHttp = false;
  let examples = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") full = true;
    else if (a === "--no-http") noHttp = true;
    else if (a === "--limit" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      limit = Number.isNaN(n) ? 20 : Math.max(1, n);
    } else if (a === "--examples" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      examples = Number.isNaN(n) ? 3 : Math.max(0, n);
    }
  }
  return { limit, full, noHttp, examples };
}

function classifyImageUrl(imageUrl: string, r2Base: string): UrlBucket {
  const base = r2Base.replace(/\/$/, "");
  if (imageUrl.startsWith(base + "/") || imageUrl === base) return "r2_full_url";
  if (imageUrl.startsWith("products/")) return "products_path_only";
  return "other_host";
}

function nobgNullReason(imageUrl: string, r2Base: string): string {
  const b = r2Base.replace(/\/$/, "");
  if (!imageUrl.startsWith(b) && !imageUrl.startsWith("products/")) {
    return "imageUrl is not R2 base nor products/… (external or wrong host)";
  }
  if (!imageUrl.startsWith(b) && imageUrl.startsWith("products/")) {
    return "products/ path OK but getNobgUrl needs R2_PUBLIC_URL to build absolute nobg URL";
  }
  const path = imageUrl.startsWith(b)
    ? imageUrl.slice(b.length).replace(/^\//, "").split("?")[0]
    : imageUrl.split("?")[0];
  if (!path.startsWith("products/")) {
    return "path under R2 base does not start with products/";
  }
  return "unknown";
}

/** HEAD then GET with Range; true if resource exists per typical R2/public behavior */
async function probeNobgUrl(nobgUrl: string): Promise<{
  headStatus: number | null;
  getStatus: number | null;
  exists: boolean;
}> {
  let headStatus: number | null = null;
  try {
    const headRes = await fetch(nobgUrl, { method: "HEAD" });
    headStatus = headRes.status;
    if (headRes.ok) {
      return { headStatus, getStatus: null, exists: true };
    }
  } catch {
    headStatus = null;
  }

  try {
    const getRes = await fetch(nobgUrl, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
    const getStatus = getRes.status;
    const ok = getRes.ok && (getStatus === 200 || getStatus === 206);
    return { headStatus, getStatus, exists: ok };
  } catch {
    return { headStatus, getStatus: null, exists: false };
  }
}

async function main() {
  const { limit, full, noHttp, examples } = parseArgs();
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

  console.log("=== Nobg / feed diagnostic ===\n");
  console.log("Note: Product `name` is display text; nobg file names come from `imageUrl` path.\n");

  const [total, activeCount, feedEligible, hasNobgDist] = await Promise.all([
    prisma.clothingItem.count(),
    prisma.clothingItem.count({ where: { active: true } }),
    prisma.clothingItem.count({ where: { active: true, hasNobg: true } }),
    prisma.clothingItem.groupBy({
      by: ["hasNobg"],
      _count: { _all: true },
    }),
  ]);

  const nullCount = hasNobgDist.find((x) => x.hasNobg === null)?._count._all ?? 0;
  const trueCount = hasNobgDist.find((x) => x.hasNobg === true)?._count._all ?? 0;
  const falseCount = hasNobgDist.find((x) => x.hasNobg === false)?._count._all ?? 0;

  console.log("--- PostgreSQL aggregates ---");
  console.log(`ClothingItem total:     ${total}`);
  console.log(`active:                 ${activeCount}`);
  console.log(`hasNobg = true:         ${trueCount}`);
  console.log(`hasNobg = false:        ${falseCount}`);
  console.log(`hasNobg IS NULL:        ${nullCount}`);
  console.log(`Feed-eligible (active AND hasNobg=true): ${feedEligible}`);
  console.log("");

  if (!R2_PUBLIC_URL) {
    console.log("R2_PUBLIC_URL not set — URL buckets and HTTP checks skipped.\n");
    await prisma.$disconnect();
    return;
  }

  const items = await prisma.clothingItem.findMany({
    where: { active: true },
    select: { id: true, name: true, imageUrl: true, hasNobg: true },
    orderBy: { createdAt: "desc" },
  });

  const bucketCounts: Record<UrlBucket, number> = {
    r2_full_url: 0,
    products_path_only: 0,
    other_host: 0,
  };
  const byBucket: Record<UrlBucket, typeof items> = {
    r2_full_url: [],
    products_path_only: [],
    other_host: [],
  };

  for (const row of items) {
    const bucket = classifyImageUrl(row.imageUrl, R2_PUBLIC_URL);
    bucketCounts[bucket]++;
    byBucket[bucket].push(row);
  }

  console.log("--- imageUrl shape (active rows) ---");
  console.log(`R2 full URL (starts with R2_PUBLIC_URL): ${bucketCounts.r2_full_url}`);
  console.log(`products/… only (relative):              ${bucketCounts.products_path_only}`);
  console.log(`Other host (external, etc.):             ${bucketCounts.other_host}`);
  console.log("");

  const firstSegmentAfterProducts = new Map<string, number>();
  for (const row of items) {
    const m = row.imageUrl.match(/products\/([^/?#]+)/);
    if (m) {
      const seg = m[1];
      firstSegmentAfterProducts.set(seg, (firstSegmentAfterProducts.get(seg) ?? 0) + 1);
    }
  }
  const topSegments = [...firstSegmentAfterProducts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  console.log("--- Top first path segments after products/ (active rows, from imageUrl) ---");
  for (const [seg, c] of topSegments) {
    console.log(`  ${seg}: ${c}`);
  }
  console.log("");

  const printExamples = (bucket: UrlBucket, label: string) => {
    if (examples === 0) return;
    const rows = byBucket[bucket].slice(0, examples);
    if (rows.length === 0) return;
    console.log(`--- Examples: ${label} (up to ${examples}) ---`);
    for (const row of rows) {
      const nobgUrl = getNobgUrl(row.imageUrl, R2_PUBLIC_URL);
      console.log(`  id: ${row.id}`);
      console.log(`  name: ${row.name}`);
      console.log(`  imageUrl: ${row.imageUrl}`);
      console.log(`  hasNobg (DB): ${row.hasNobg === null ? "NULL" : String(row.hasNobg)}`);
      if (nobgUrl) {
        console.log(`  derived nobgUrl: ${nobgUrl}`);
      } else {
        console.log(`  derived nobgUrl: null (${nobgNullReason(row.imageUrl, R2_PUBLIC_URL)})`);
      }
      console.log("");
    }
  };

  printExamples("r2_full_url", "R2 full URL");
  printExamples("products_path_only", "products/ path only");
  printExamples("other_host", "other host");

  if (noHttp) {
    console.log("--no-http: skipping R2 HTTP probes.\n");
    await prisma.$disconnect();
    return;
  }

  const withNobgUrl = items
    .map((row) => {
      const nobgUrl = getNobgUrl(row.imageUrl, R2_PUBLIC_URL);
      return { row, nobgUrl };
    })
    .filter((x): x is { row: (typeof items)[0]; nobgUrl: string } => x.nobgUrl !== null);

  const probeBatch = full ? withNobgUrl : withNobgUrl.slice(0, limit);
  console.log(`--- HTTP probe (HEAD then GET Range) ---`);
  console.log(`Rows with derivable nobgUrl: ${withNobgUrl.length} (checking ${probeBatch.length}${full ? " all" : `, cap ${limit} unless --full`})`);

  let headOk = 0;
  let headFailGetOk = 0;
  let bothFail = 0;
  let dbTrueButMissing = 0;
  let dbFalseOrNullButPresent = 0;
  let dbMatch = 0;

  const headFailGetOkSamples: string[] = [];
  const bothFailSamples: string[] = [];

  const BATCH = 40;
  for (let i = 0; i < probeBatch.length; i += BATCH) {
    const chunk = probeBatch.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async ({ row, nobgUrl }) => {
        const probe = await probeNobgUrl(nobgUrl);
        return { row, nobgUrl, ...probe };
      })
    );

    for (const r of results) {
      const dbSays = r.row.hasNobg === true;
      if (r.headStatus !== null && r.headStatus >= 200 && r.headStatus < 300) {
        headOk++;
      } else if (r.exists) {
        headFailGetOk++;
        if (headFailGetOkSamples.length < 5) headFailGetOkSamples.push(r.nobgUrl);
      } else {
        bothFail++;
        if (bothFailSamples.length < 5) bothFailSamples.push(r.nobgUrl);
      }

      if (dbSays && !r.exists) dbTrueButMissing++;
      else if (!dbSays && r.exists) dbFalseOrNullButPresent++;
      else dbMatch++;
    }
    process.stdout.write(`\r  Progress: ${Math.min(i + chunk.length, probeBatch.length)}/${probeBatch.length}`);
  }
  console.log("\n");

  console.log("Probe summary:");
  console.log(`  HEAD returned 2xx:           ${headOk}`);
  console.log(`  HEAD failed, GET Range ok: ${headFailGetOk}`);
  console.log(`  Neither indicates present: ${bothFail}`);
  if (headFailGetOkSamples.length) {
    console.log("  Sample nobg URLs (HEAD fail, GET ok):");
    for (const u of headFailGetOkSamples) console.log(`    ${u}`);
  }
  if (bothFailSamples.length) {
    console.log("  Sample nobg URLs (both fail):");
    for (const u of bothFailSamples) console.log(`    ${u}`);
  }
  console.log("");

  console.log("--- DB hasNobg vs HTTP probe (sampled rows above) ---");
  console.log(`  DB hasNobg=true but not present:     ${dbTrueButMissing}`);
  console.log(`  DB false/NULL but present:           ${dbFalseOrNullButPresent}`);
  console.log(`  Agreement (or both absent):        ${dbMatch}`);
  console.log("");
  console.log("If feed-eligible count is 0 but HTTP shows many present, run: npm run populate-has-nobg");
  console.log("If HEAD fails often but GET ok, ensure nobgExists uses GET fallback (see src/lib/images.ts).");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
