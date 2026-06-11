-- Case-insensitive email uniqueness.
--
-- The app normalizes emails to lowercase on every write and lookup
-- (src/lib/emailAddress.ts); this migration brings existing rows in line and
-- adds a database-level backstop. It is deliberately defensive so a deploy
-- can never fail on legacy data:
--   1. lowercase existing emails ONLY where that cannot collide with another row
--   2. add the unique index ONLY if no case-duplicates remain (else warn + skip)

UPDATE "User" u
SET "email" = lower("email")
WHERE "email" <> lower("email")
  AND NOT EXISTS (
    SELECT 1 FROM "User" o
    WHERE o."id" <> u."id" AND lower(o."email") = lower(u."email")
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User" GROUP BY lower("email") HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'email_lower_unique: case-duplicate emails exist; index skipped — resolve duplicates and re-create "User_email_lower_key" manually';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key" ON "User" (lower("email"));
  END IF;
END $$;
