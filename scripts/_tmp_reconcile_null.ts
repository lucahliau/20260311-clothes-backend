import "dotenv/config";
import { Pool } from "pg";
import { getNobgUrl, nobgExists } from "../src/lib/images.js";

const R2 = process.env.R2_PUBLIC_URL!;
if (!R2) {
  console.error("R2_PUBLIC_URL unset");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 4 });

async function q<T = any>(sql: string, params?: any[]): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await pool.query(sql, params);
      return r.rows as T[];
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Only the drifted population: active items with a NULL flag. Resumable —
// re-running continues, since flipped rows are no longer NULL.
const items = await q<{ id: string; imageUrl: string }>(
  `SELECT id, "imageUrl" FROM "ClothingItem" WHERE active AND "hasNobg" IS NULL`,
);
console.log(`NULL-flag active items to reconcile: ${items.length}`);

const CONC = 40;
let trueIds: string[] = [];
let falseIds: string[] = [];
let probed = 0,
  flippedTrue = 0,
  flippedFalse = 0;

async function flush(ids: string[], value: boolean) {
  if (ids.length === 0) return;
  await q(
    `UPDATE "ClothingItem" ci SET "hasNobg" = ${value}, "updatedAt" = NOW()
     FROM unnest($1::text[]) AS k(id) WHERE ci.id = k.id AND ci."hasNobg" IS NULL`,
    [ids],
  );
}

for (let i = 0; i < items.length; i += CONC) {
  const chunk = items.slice(i, i + CONC);
  // HTTP probe WITHOUT holding a DB connection (this was populate-has-nobg's bug).
  await Promise.all(
    chunk.map(async (it) => {
      const u = getNobgUrl(it.imageUrl, R2);
      const ok = u ? await nobgExists(u) : false;
      (ok ? trueIds : falseIds).push(it.id);
    }),
  );
  probed += chunk.length;
  if (trueIds.length >= 500) {
    flippedTrue += trueIds.length;
    await flush(trueIds, true);
    trueIds = [];
  }
  if (falseIds.length >= 500) {
    flippedFalse += falseIds.length;
    await flush(falseIds, false);
    falseIds = [];
  }
  if (probed % 1000 < CONC)
    console.log(`  probed ${probed}/${items.length} | →true≈${flippedTrue} →false≈${flippedFalse}`);
}
flippedTrue += trueIds.length;
flippedFalse += falseIds.length;
await flush(trueIds, true);
await flush(falseIds, false);

console.log(`\nDONE: reconciled ${probed} NULL items → true=${flippedTrue}, false=${flippedFalse}`);

// Show the resulting feed-eligible footprint
const [agg] = await q<{ feed_items: number; feed_brands: number }>(
  `SELECT COUNT(*) FILTER (WHERE active AND "hasNobg"=true AND "isClothing" IS NOT FALSE)::int AS feed_items,
          COUNT(DISTINCT brand) FILTER (WHERE active AND "hasNobg"=true AND "isClothing" IS NOT FALSE)::int AS feed_brands
   FROM "ClothingItem"`,
);
console.log(`Feed-eligible now: ${agg.feed_items} items across ${agg.feed_brands} brands`);

await pool.end();
