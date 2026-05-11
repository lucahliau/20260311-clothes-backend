-- HNSW index for cosine-distance ANN search over ItemEmbedding.vector.
-- Required by the personalized feed: without it, the per-cluster top-N
-- pgvector queries fall back to sequential scan.
CREATE INDEX IF NOT EXISTS "ItemEmbedding_vector_hnsw_cosine_idx"
    ON "ItemEmbedding"
    USING hnsw (vector vector_cosine_ops);
