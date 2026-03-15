-- AlterTable
ALTER TABLE "ClothingItem" ADD COLUMN "retailer" TEXT,
ADD COLUMN "externalId" TEXT,
ADD COLUMN "manufacturerCode" TEXT,
ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ClothingItem_retailer_idx" ON "ClothingItem"("retailer");

-- CreateIndex (unique compound)
CREATE UNIQUE INDEX "ClothingItem_retailer_externalId_key" ON "ClothingItem"("retailer", "externalId");

-- CreateTable
CREATE TABLE "ScrapedRaw" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "retailer" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ScrapedRaw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScrapedRaw_sourceUrl_key" ON "ScrapedRaw"("sourceUrl");

-- CreateIndex
CREATE INDEX "ScrapedRaw_retailer_idx" ON "ScrapedRaw"("retailer");

-- CreateIndex
CREATE INDEX "ScrapedRaw_processed_idx" ON "ScrapedRaw"("processed");
