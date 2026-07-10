-- Partial index on the nobg-completion timestamp the crawler stamps into
-- metadata (setHasNobgForKeys). The dashboard's /api/processing nobg-rate query
-- filters `WHERE metadata ? 'nobgAt'` and compares (metadata->>'nobgAt')::timestamptz;
-- without this it de-TOASTs + parses the full metadata JSONB on all ~60k rows
-- (~9s per dashboard load). The partial index covers only the small set of
-- processed rows, cutting the query to <0.1s. NON-concurrent + IF NOT EXISTS:
-- already applied live on prod (no-op there), builds cheaply on a fresh DB.
CREATE INDEX IF NOT EXISTS "idx_ci_nobgat"
  ON "ClothingItem" ((metadata->>'nobgAt'))
  WHERE metadata ? 'nobgAt';
