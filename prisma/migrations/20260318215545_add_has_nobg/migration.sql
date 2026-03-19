-- AlterTable
ALTER TABLE "ClothingItem" ADD COLUMN "hasNobg" BOOLEAN;

-- CreateIndex
CREATE INDEX "ClothingItem_hasNobg_idx" ON "ClothingItem"("hasNobg");
