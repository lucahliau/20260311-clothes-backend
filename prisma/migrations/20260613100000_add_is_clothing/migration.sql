-- Heuristic classification fields for ClothingItem. `isClothing=false`
-- soft-hides non-wearables (wallets, candles, camping gear…) from every
-- feed/list without deleting the row; NULL = unclassified → treated as visible
-- (queries use `isClothing IS NOT FALSE`). Written by the crawler's classify.ts
-- on upsert plus a one-time backfill (scripts/classify-catalog.ts).

ALTER TABLE "ClothingItem" ADD COLUMN "isClothing" BOOLEAN;
ALTER TABLE "ClothingItem" ADD COLUMN "classifiedAt" TIMESTAMP(3);
ALTER TABLE "ClothingItem" ADD COLUMN "classificationConfidence" DOUBLE PRECISION;

CREATE INDEX "ClothingItem_isClothing_idx" ON "ClothingItem"("isClothing");
