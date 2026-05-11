-- Enable pgvector (required for similarity search later)
CREATE EXTENSION IF NOT EXISTS vector;

-- ItemEmbedding: one row per (ClothingItem, model). Default model clip-vit-b-32-image uses 512-dim CLIP vectors.
-- Other embedding dimensions require a follow-up migration (pgvector column dimension is fixed per column).
-- All ID columns are TEXT to match Prisma's String @id @default(uuid()) representation in this DB.
CREATE TABLE "ItemEmbedding" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" vector(512) NOT NULL,
    "embeddedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ItemEmbedding_itemId_model_key" ON "ItemEmbedding"("itemId", "model");
CREATE INDEX "ItemEmbedding_model_idx" ON "ItemEmbedding"("model");
CREATE INDEX "ItemEmbedding_itemId_idx" ON "ItemEmbedding"("itemId");

ALTER TABLE "ItemEmbedding"
    ADD CONSTRAINT "ItemEmbedding_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "ClothingItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
