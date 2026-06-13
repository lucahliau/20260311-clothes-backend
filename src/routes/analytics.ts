import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { optionalAuth } from "../middleware/auth.js";
import { analyticsLimiter } from "../middleware/rateLimit.js";
import type { Prisma } from "../../generated/prisma/client.js";

const router = Router();

// Keep this list in lockstep with the iOS client's AnalyticsManager event
// names. Unknown names are rejected so a typo in the app can't silently
// pollute the table — add new names here (and a matching migration is NOT
// needed; eventName is a free-text column) when the client adds an event.
const EVENT_NAMES = [
  "session_start",
  "session_end",
  "screen_view",
  "item_view",
  "search",
  "onboarding_complete",
] as const;

const eventSchema = z.object({
  eventName: z.enum(EVENT_NAMES),
  screenName: z.string().max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Client-stamped time; events arrive batched/late, so trust this for ordering
  // and keep createdAt as the server receipt time.
  clientTs: z.coerce.date().optional(),
});

const ingestSchema = z.object({
  sessionId: z.string().uuid(),
  events: z.array(eventSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// POST /analytics/ingest
// ---------------------------------------------------------------------------
// Fire-and-forget batch ingest from the iOS app. optionalAuth so events still
// flow when a token is briefly expired (or for pre-login screens); userId is
// null in that case. One createMany, no reads — the cheapest possible write.
// All aggregation/reads happen off-band on the crawler dashboard.

router.post("/ingest", optionalAuth, analyticsLimiter, async (req: Request, res: Response) => {
  const { sessionId, events } = ingestSchema.parse(req.body);
  const userId = req.user?.userId ?? null;

  const result = await prisma.analyticsEvent.createMany({
    data: events.map((e) => ({
      sessionId,
      userId,
      eventName: e.eventName,
      screenName: e.screenName,
      metadata: e.metadata as Prisma.InputJsonValue | undefined,
      clientTs: e.clientTs,
    })),
  });

  res.status(202).json({ inserted: result.count });
});

export default router;
