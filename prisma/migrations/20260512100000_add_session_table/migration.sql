-- Per-device session rows for refresh tokens. Replaces the single
-- `User.refreshTokenHash` slot so concurrent refreshes don't invalidate each
-- other and multi-device logins work the way users expect.
--
-- `User.refreshTokenHash` is intentionally left in place by this migration.
-- A follow-up migration will drop it once telemetry confirms no client is
-- still landing in the legacy path.

CREATE TABLE "Session" (
    "id"                       TEXT NOT NULL,
    "userId"                   TEXT NOT NULL,
    "deviceId"                 TEXT NOT NULL,
    "refreshTokenHash"         TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "rotatedAt"                TIMESTAMP(3),
    "expiresAt"                TIMESTAMP(3) NOT NULL,
    "lastSeenAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent"                TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");
CREATE UNIQUE INDEX "Session_previousRefreshTokenHash_key" ON "Session"("previousRefreshTokenHash");
CREATE UNIQUE INDEX "Session_userId_deviceId_key" ON "Session"("userId", "deviceId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every user with an active refresh token gets one Session row
-- keyed by a synthetic "legacy-<userId>" deviceId. The first time the iOS
-- client refreshes with a real `deviceId`, login will replace this row.
INSERT INTO "Session" ("id", "userId", "deviceId", "refreshTokenHash", "expiresAt", "lastSeenAt", "createdAt")
SELECT
    gen_random_uuid()::text,
    u.id,
    'legacy-' || u.id,
    u."refreshTokenHash",
    NOW() + INTERVAL '30 days',
    NOW(),
    NOW()
FROM "User" u
WHERE u."refreshTokenHash" IS NOT NULL
ON CONFLICT DO NOTHING;
