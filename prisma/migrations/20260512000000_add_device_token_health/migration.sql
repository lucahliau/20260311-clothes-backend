-- Track device token health so dead tokens (APNS 410 / 400 BadDeviceToken)
-- can be pruned and chronically-failing tokens can be detected.
ALTER TABLE "DeviceToken"
    ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
    ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastFailureAt" TIMESTAMP(3);
