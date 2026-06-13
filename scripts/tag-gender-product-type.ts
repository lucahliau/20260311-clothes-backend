/**
 * DEPRECATED — superseded by the crawler's heuristic classifier
 * (`20260315 crawlerconfig/src/classify.ts` + `scripts/classify-catalog.ts`),
 * which resolves gender/productType AND clothing-vs-non-clothing from all text
 * signals. This script's `unknown gender → unisex` default is the exact bug
 * that leaked dresses/skirts into men's feeds, so re-running it would CLOBBER
 * the good data. Kept only for reference; it refuses to run without
 * `--force-legacy`.
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

type Gender = "male" | "female" | "unisex";
type ProductType = "tops" | "bottoms" | "bags" | "accessories" | "jackets" | "other";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const FEMALE_SUB_PATTERNS = [
  "dress",
  "skirt",
  "camisole",
  "crop tank",
  "crop hoodie",
  "ballet flat",
  "flats",
  "sandals",
  "platform sandals",
];

const MALE_SUB_PATTERNS = [
  "oxford",
  "polo",
  "chinos",
  "bermuda shorts",
  "sweat shorts",
  "desert boot",
];

function inferGender(category: string, subcategory: string | null): Gender {
  const cat = category.toLowerCase().trim();
  const sub = (subcategory ?? "").toLowerCase().trim();

  for (const p of FEMALE_SUB_PATTERNS) {
    if (sub.includes(p)) return "female";
  }
  for (const p of MALE_SUB_PATTERNS) {
    if (sub.includes(p)) return "male";
  }

  if (cat === "tops" && (sub.includes("crop") || sub.includes("camisole"))) return "female";
  if (cat === "bottoms" && sub.includes("skirt")) return "female";
  if (cat === "shoes" && (sub.includes("flat") || sub.includes("sandals") || sub.includes("heel")))
    return "female";

  return "unisex";
}

function inferProductType(category: string, subcategory: string | null): ProductType {
  const cat = category.toLowerCase().trim();
  const sub = (subcategory ?? "").toLowerCase().trim();

  if (cat === "tops") return "tops";
  if (cat === "bottoms" || cat === "trousers" || cat === "pants") return "bottoms";

  if (cat === "outerwear") return "jackets";

  if (cat === "accessories") {
    if (
      sub.includes("bag") ||
      sub.includes("tote") ||
      sub.includes("crossbody") ||
      sub.includes("backpack")
    )
      return "bags";
    return "accessories";
  }

  if (cat === "shoes") return "accessories";

  return "other";
}

function _normalizeGender(gender: string | null): Gender {
  if (!gender) return "unisex";
  const g = gender.toLowerCase().trim();
  if (g === "men" || g === "male") return "male";
  if (g === "women" || g === "female") return "female";
  if (g === "unisex") return "unisex";
  return "unisex";
}

async function main() {
  if (!process.argv.includes("--force-legacy")) {
    console.error(
      "DEPRECATED: this legacy tagger defaults unknown gender → unisex and would\n" +
        "overwrite the crawler's classification (re-leaking dresses into men's feeds).\n" +
        "Use the crawler's scripts/classify-catalog.ts instead. Pass --force-legacy to override.",
    );
    process.exit(1);
  }
  console.log("Fetching clothing items...\n");

  const items = await prisma.clothingItem.findMany({
    where: {
      OR: [{ gender: null }, { productType: null }],
    },
    select: {
      id: true,
      name: true,
      category: true,
      subcategory: true,
      gender: true,
      productType: true,
    },
  });

  console.log(`Processing ${items.length} items (missing gender or productType)...\n`);

  let updated = 0;
  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const inferredGender = inferGender(item.category, item.subcategory);
    const inferredProductType = inferProductType(item.category, item.subcategory);

    await prisma.clothingItem.update({
      where: { id: item.id },
      data: {
        gender: inferredGender,
        productType: inferredProductType,
      },
    });
    updated++;

    if (updated <= 10) {
      console.log(
        `  [${item.name}] category=${item.category} sub=${item.subcategory ?? "-"} → gender=${inferredGender} productType=${inferredProductType}`,
      );
    }

    const pct = Math.round(((i + 1) / total) * 100);
    process.stdout.write(`\r  Progress: ${i + 1}/${total} (${pct}%) | updated: ${updated}    `);
  }

  process.stdout.write("\r" + " ".repeat(80) + "\r");

  console.log("\n--- Summary ---");
  console.log(`Total processed: ${items.length}`);
  console.log(`Updated: ${updated}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
