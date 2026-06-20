-- Sale pricing for ClothingItem. `price` remains the CURRENT effective price the
-- customer pays (USD-normalized). When an item is on sale the crawler also sets
-- `compareAtPrice` (the struck "was" price, > price) and `salePrice` (== price,
-- the "now" price); both NULL when not on sale. Additive + nullable, so every
-- existing filter / serve path / frontend priceDouble is unaffected — sale is
-- purely additive. Written by the crawler (Shopify compare_at_price, or per-page
-- JSON-LD/OG). No index: sale is displayed, not filtered on.

ALTER TABLE "ClothingItem" ADD COLUMN "salePrice" DECIMAL(10,2);
ALTER TABLE "ClothingItem" ADD COLUMN "compareAtPrice" DECIMAL(10,2);
