-- AlterTable
ALTER TABLE "ClothingItem" ADD COLUMN     "productType" TEXT;

-- CreateIndex
CREATE INDEX "ClothingItem_productType_idx" ON "ClothingItem"("productType");
