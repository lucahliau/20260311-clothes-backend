-- Relevance-ranked /items search support.
-- Hand-authored (shared prod Supabase — never `prisma migrate dev`).
-- Non-concurrent CREATE INDEX is fine at the current catalog size (~16k rows)
-- and is REQUIRED: `prisma migrate deploy` runs each migration inside a
-- transaction, where CREATE INDEX CONCURRENTLY would error.

-- Trigram matching powers fast, case-insensitive substring + fuzzy search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes on the searched text columns (name/brand/description ILIKE).
CREATE INDEX IF NOT EXISTS "ClothingItem_name_trgm_idx"
  ON "ClothingItem" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ClothingItem_brand_trgm_idx"
  ON "ClothingItem" USING gin (brand gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ClothingItem_description_trgm_idx"
  ON "ClothingItem" USING gin (description gin_trgm_ops);

-- Covers the default browse sort and the search tie-break (ORDER BY ... createdAt DESC).
CREATE INDEX IF NOT EXISTS "ClothingItem_createdAt_idx"
  ON "ClothingItem" ("createdAt" DESC);
