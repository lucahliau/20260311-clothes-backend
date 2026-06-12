-- User-filed abuse reports (App Store guideline 1.2: messaging apps must
-- offer report + block). Rows are reviewed out-of-band; status moves
-- open -> reviewed/actioned.

CREATE TABLE "UserReport" (
    "id"             TEXT NOT NULL,
    "reporterId"     TEXT NOT NULL,
    "reportedUserId" TEXT NOT NULL,
    "reason"         TEXT NOT NULL,
    "details"        TEXT,
    "status"         TEXT NOT NULL DEFAULT 'open',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserReport_reportedUserId_idx" ON "UserReport"("reportedUserId");
CREATE INDEX "UserReport_status_createdAt_idx" ON "UserReport"("status", "createdAt");

ALTER TABLE "UserReport"
    ADD CONSTRAINT "UserReport_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserReport"
    ADD CONSTRAINT "UserReport_reportedUserId_fkey"
    FOREIGN KEY ("reportedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
