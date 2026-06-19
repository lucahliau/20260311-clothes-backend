-- People-photo detection fields for ClothingItem. `hasPerson=true` soft-hides
-- products whose only images are of a model/person (the app should show the
-- garment, not the person) from every feed/list without deleting the row;
-- NULL = not yet scanned → treated as visible (queries use `hasPerson IS NOT
-- TRUE`). Written by bgremover/person_scan_worker.py (local YOLO on the
-- ORIGINAL images) plus a one-time backfill. personScannedAt marks a completed
-- scan so the worker can find unscanned rows.

ALTER TABLE "ClothingItem" ADD COLUMN "hasPerson" BOOLEAN;
ALTER TABLE "ClothingItem" ADD COLUMN "personScannedAt" TIMESTAMP(3);
ALTER TABLE "ClothingItem" ADD COLUMN "personScanConfidence" DOUBLE PRECISION;

CREATE INDEX "ClothingItem_hasPerson_idx" ON "ClothingItem"("hasPerson");
