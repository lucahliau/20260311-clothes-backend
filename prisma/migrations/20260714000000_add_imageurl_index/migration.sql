-- Btree on imageUrl: the crawler's setHasNobgForKeys (bridge.ts) flips hasNobg
-- by EXACT imageUrl match after every nobg batch. Before 2026-07-14 that query
-- used a leading-wildcard LIKE with no index — a full-table scan per batch that
-- saturated the shared Supabase DB (statement timeouts + pool exhaustion across
-- backend AND crawler for 1h+). Equality + this index = per-key index probes.
CREATE INDEX IF NOT EXISTS "ClothingItem_imageUrl_idx" ON "ClothingItem"("imageUrl");
