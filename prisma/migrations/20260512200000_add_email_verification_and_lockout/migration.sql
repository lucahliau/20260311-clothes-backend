-- Email verification + per-account login lockout.
--
-- Closes two abuse surfaces:
--  1. Anonymous registrants squatting (email, username) pairs forever — fixed
--     by requiring a one-token email confirmation on password signup.
--  2. Distributed credential-stuffing that bypasses IP-based authLimiter — fixed
--     by a per-user failed-attempt counter + temporary lock.
--
-- Existing users are grandfathered as verified so this migration is non-breaking
-- for current sessions. OAuth-linked users (appleId/googleId set) are also
-- treated as verified going forward; the app layer enforces that on create/link.

ALTER TABLE "User"
    ADD COLUMN "emailVerified"              BOOLEAN      NOT NULL DEFAULT false,
    ADD COLUMN "emailVerificationTokenHash" TEXT,
    ADD COLUMN "emailVerificationExpiry"    TIMESTAMP(3),
    ADD COLUMN "failedLoginAttempts"        INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN "lockedUntil"                TIMESTAMP(3);

CREATE UNIQUE INDEX "User_emailVerificationTokenHash_key"
    ON "User"("emailVerificationTokenHash");

-- Grandfather every existing row: anyone already in the DB has been using the
-- app, so we don't want to lock them out at deploy time.
UPDATE "User" SET "emailVerified" = true;
