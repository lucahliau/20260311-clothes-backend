/**
 * Populates hasNobg for ClothingItems by checking if the -nobg.png image exists at R2.
 * Run after migration add_has_nobg. Feed will filter to hasNobg=true.
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

  console.log(`Checking ${items.length} items for nobg...\n`);

  const BATCH_SIZE = 50;
  let updated = 0;
  let noPath = 0;
  let missing = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        const nobgUrl = getNobgUrl(item.imageUrl, R2_PUBLIC_URL);
        if (!nobgUrl) return { item, hasNobg: false, reason: "no-path" as const };
        const exists = await nobgExists(nobgUrl);
        return { item, hasNobg: exists, reason: exists ? "ok" : ("404" as const) };
      })
    );

    for (const r of results) {
      if (r.reason === "no-path") {
        noPath++;
        await prisma.clothingItem.update({
          where: { id: r.item.id },
          data: { hasNobg: false },
        });
      } else if (r.hasNobg) {
        updated++;
        await prisma.clothingItem.update({
          where: { id: r.item.id },
          data: { hasNobg: true },
        });
      } else {
        missing++;
        await prisma.clothingItem.update({
          where: { id: r.item.id },
          data: { hasNobg: false },
        });
      }
    }

    const pct = Math.round(((i + batch.length) / items.length) * 100);
    process.stdout.write(`\r  Progress: ${i + batch.length}/${items.length} (${pct}%) | hasNobg: ${updated} | no path: ${noPath} | 404: ${missing}    `);
  }

  console.log("\n\n--- Summary ---");
  console.log(`Total: ${items.length}`);
  console.log(`hasNobg=true: ${updated}`);
  console.log(`hasNobg=false (no R2 path): ${noPath}`);
  console.log(`hasNobg=false (404): ${missing}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
