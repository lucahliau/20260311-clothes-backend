-- Stock status from the retailer's live listing. NULL = unknown (not yet
-- refreshed), TRUE = purchasable, FALSE = sold out OR delisted from the store.
-- Items are NEVER hidden for stock reasons (product decision 2026-07-09) —
-- the app renders a "SOLD OUT" tag instead.
ALTER TABLE "ClothingItem" ADD COLUMN "inStock" BOOLEAN;
