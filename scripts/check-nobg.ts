/**
 * Quick script to check for nobg files.
 * Fetches items from DB and checks if their imageUrl has a nobg counterpart.
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { getNobgUrl, nobgExists } from "../src/lib/images.js";

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  if (!R2_PUBLIC_URL) {
    console.log("R2_PUBLIC_URL not set");
    return;
  }

  const items = await prisma.clothingItem.findMany({
    where: { active: true },
    select: { id: true, name: true, imageUrl: true },
  });

  console.log(`\nChecking ${items.length} items from DB (parallel)...\n`);

  const BATCH_SIZE = 100;
  const results: { item: (typeof items)[0]; nobgUrl: string | null; exists: boolean }[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const nobgUrl = getNobgUrl(item.imageUrl, R2_PUBLIC_URL);
        if (!nobgUrl) return { item, nobgUrl: null as string | null, exists: false };
        const exists = await nobgExists(nobgUrl);
        return { item, nobgUrl, exists };
      }),
    );
    results.push(...batchResults);
    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= items.length) {
      process.stdout.write(
        `  Progress: ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}\r`,
      );
    }
  }

  let withNobg = 0;
  let noNobgPath = 0;
  let nobgMissing = 0;

  for (const r of results) {
    if (!r.nobgUrl) {
      noNobgPath++;
      if (noNobgPath <= 5) {
        console.log(`[no path] ${r.item.name}`);
        console.log(`  imageUrl: ${r.item.imageUrl}\n`);
      }
      continue;
    }
    if (r.exists) {
      withNobg++;
      if (withNobg <= 10) {
        console.log(`[HAS nobg] ${r.item.name}`);
        console.log(`  nobg: ${r.nobgUrl}\n`);
      }
    } else {
      nobgMissing++;
      if (nobgMissing <= 5) {
        console.log(`[nobg 404] ${r.item.name}`);
        console.log(`  nobg: ${r.nobgUrl}\n`);
      }
    }
  }

  console.log("--- Summary ---");
  console.log(`Total checked: ${items.length}`);
  console.log(`With nobg (200): ${withNobg}`);
  console.log(`No nobg path (external URLs): ${noNobgPath}`);
  console.log(`Nobg URL returns 404: ${nobgMissing}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
