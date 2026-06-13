-- Append-only product-analytics events emitted by the iOS app (sessions,
-- screen views, item views, searches). No FK to "User": events outlive account
-- deletion so retention/cohort analysis stays correct; "userId" is null for
-- pre-login events. Aggregated off-band by the crawler dashboard.

CREATE TABLE "AnalyticsEvent" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT,
    "sessionId"  TEXT NOT NULL,
    "eventName"  TEXT NOT NULL,
    "screenName" TEXT,
    "metadata"   JSONB,
    "clientTs"   TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsEvent_eventName_createdAt_idx" ON "AnalyticsEvent"("eventName", "createdAt");
CREATE INDEX "AnalyticsEvent_userId_createdAt_idx" ON "AnalyticsEvent"("userId", "createdAt");
CREATE INDEX "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");
