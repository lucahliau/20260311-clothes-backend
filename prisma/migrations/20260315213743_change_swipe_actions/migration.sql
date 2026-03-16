-- Create new enum with updated values
CREATE TYPE "SwipeAction_new" AS ENUM ('LOVE', 'LIKE', 'DISLIKE', 'NEUTRAL');

-- Add temporary column with new enum type
ALTER TABLE "Swipe" ADD COLUMN "action_new" "SwipeAction_new";

-- Migrate existing data: LIKE->LIKE, PASS->DISLIKE, SUPERLIKE->LOVE
UPDATE "Swipe" SET "action_new" = 
  CASE "action"
    WHEN 'LIKE' THEN 'LIKE'::"SwipeAction_new"
    WHEN 'PASS' THEN 'DISLIKE'::"SwipeAction_new"
    WHEN 'SUPERLIKE' THEN 'LOVE'::"SwipeAction_new"
  END;

-- Make new column NOT NULL and swap columns
ALTER TABLE "Swipe" ALTER COLUMN "action_new" SET NOT NULL;
ALTER TABLE "Swipe" DROP COLUMN "action";
ALTER TABLE "Swipe" RENAME COLUMN "action_new" TO "action";

-- Replace old enum with new one
DROP TYPE "SwipeAction";
ALTER TYPE "SwipeAction_new" RENAME TO "SwipeAction";
