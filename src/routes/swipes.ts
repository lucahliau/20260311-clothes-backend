import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { swipeLimiter, swipeBatchLimiter } from "../middleware/rateLimit.js";
import { AppError } from "../middleware/error.js";
import { invalidateUserClusters } from "../services/feed-personalization.js";
import { withCdnImages } from "../lib/imageCdn.js";
import type { ClothingItem } from "../../generated/prisma/client.js";

const router = Router();

/** Rewrite the embedded item's image URLs onto the CDN (no-op when IMG_CDN_HOST unset). */
function withCdnItem<T extends { item: ClothingItem }>(swipe: T): T {
  return { ...swipe, item: withCdnImages(swipe.item) };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const swipeSchema = z.object({
  itemId: z.string().uuid(),
  action: z.enum(["LOVE", "LIKE", "DISLIKE", "NEUTRAL"]),
});

const batchSwipeSchema = z.object({
  swipes: z.array(swipeSchema).min(1).max(100),
});

const updateSwipeSchema = z.object({
  action: z.enum(["LOVE", "LIKE", "DISLIKE", "NEUTRAL"]),
});

// ---------------------------------------------------------------------------
// POST /swipes
// ---------------------------------------------------------------------------

router.post("/", requireAuth, swipeLimiter, async (req: Request, res: Response) => {
  const { itemId, action } = swipeSchema.parse(req.body);
  const userId = req.user!.userId;

  const item = await prisma.clothingItem.findUnique({ where: { id: itemId, active: true } });
  if (!item) {
    throw new AppError(404, "NOT_FOUND", "Item not found");
  }

  // Idempotent: re-swiping an item updates the stored action instead of
  // 409ing. The shipped app re-presents a card whose swipe POST failed, so a
  // 409 left users stuck on the same card forever.
  const swipe = await prisma.swipe.upsert({
    where: { userId_itemId: { userId, itemId } },
    create: { userId, itemId, action },
    update: { action },
    include: { item: true },
  });

  invalidateUserClusters(userId);
  res.status(201).json(withCdnItem(swipe));
});

// ---------------------------------------------------------------------------
// POST /swipes/batch
// ---------------------------------------------------------------------------
// The app records swipes into a local queue and flushes them here in batches so
// rapid swiping never trips the per-swipe limiter and the UI never waits on the
// network. Idempotent (upsert, last action wins), and clusters are invalidated
// ONCE per batch instead of once per swipe — which keeps the personalized feed
// cache warm during active swiping (see feed-personalization SWR).

router.post("/batch", requireAuth, swipeBatchLimiter, async (req: Request, res: Response) => {
  const { swipes } = batchSwipeSchema.parse(req.body);
  const userId = req.user!.userId;

  // Dedupe by itemId (last action wins) so one transaction never upserts the
  // same (userId,itemId) twice.
  const byItem = new Map<string, (typeof swipes)[number]["action"]>();
  for (const s of swipes) byItem.set(s.itemId, s.action);

  // Keep only itemIds that still exist and are active; unknown/deactivated items
  // are skipped rather than failing the whole batch (the queue may carry a swipe
  // for an item that was since removed). Also avoids a foreign-key abort.
  const existing = await prisma.clothingItem.findMany({
    where: { id: { in: [...byItem.keys()] }, active: true },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((i) => i.id));
  const recordable = [...byItem.entries()].filter(([itemId]) => existingIds.has(itemId));

  if (recordable.length > 0) {
    await prisma.$transaction(
      recordable.map(([itemId, action]) =>
        prisma.swipe.upsert({
          where: { userId_itemId: { userId, itemId } },
          create: { userId, itemId, action },
          update: { action },
        }),
      ),
    );
    invalidateUserClusters(userId);
  }

  res.status(200).json({ accepted: recordable.length, skipped: byItem.size - recordable.length });
});

// ---------------------------------------------------------------------------
// GET /swipes/history
// ---------------------------------------------------------------------------

router.get("/history", requireAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId: req.user!.userId };

  // `action` accepts one value (`?action=LOVE`) or a comma-separated list
  // (`?action=LOVE,LIKE`) — the latter backs the Wardrobe, which pulls the
  // whole favorited closet in one filtered query instead of slicing it out of
  // the recency-windowed mixed history. Unknown tokens are dropped; an
  // empty/garbage value falls through to "all actions" (unchanged default).
  const validActions = ["LOVE", "LIKE", "DISLIKE", "NEUTRAL"];
  const actionParam = typeof req.query.action === "string" ? req.query.action : undefined;
  if (actionParam) {
    const actions = [
      ...new Set(
        actionParam
          .split(",")
          .map((a) => a.trim().toUpperCase())
          .filter((a) => validActions.includes(a)),
      ),
    ];
    if (actions.length === 1) {
      where.action = actions[0];
    } else if (actions.length > 1) {
      where.action = { in: actions };
    }
  }

  const [swipes, total] = await Promise.all([
    prisma.swipe.findMany({
      where,
      include: { item: true },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.swipe.count({ where }),
  ]);

  res.json({
    swipes: swipes.map(withCdnItem),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /swipes/last
// ---------------------------------------------------------------------------

router.delete("/last", requireAuth, async (req: Request, res: Response) => {
  const lastSwipe = await prisma.swipe.findFirst({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    include: { item: true },
  });

  if (!lastSwipe) {
    throw new AppError(404, "NOT_FOUND", "No swipes to undo");
  }

  await prisma.swipe.delete({ where: { id: lastSwipe.id } });

  invalidateUserClusters(req.user!.userId);
  res.json({ message: "Last swipe undone", undone: withCdnItem(lastSwipe) });
});

// ---------------------------------------------------------------------------
// PATCH /swipes/:id
// ---------------------------------------------------------------------------

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : req.params.id?.[0];
  if (!id) {
    throw new AppError(400, "BAD_REQUEST", "Invalid swipe ID");
  }
  const { action } = updateSwipeSchema.parse(req.body);
  const userId = req.user!.userId;

  const existing = await prisma.swipe.findUnique({
    where: { id },
  });

  if (!existing || existing.userId !== userId) {
    throw new AppError(404, "NOT_FOUND", "Swipe not found");
  }

  const swipe = await prisma.swipe.update({
    where: { id },
    data: { action },
    include: { item: true },
  });

  invalidateUserClusters(userId);
  res.json(withCdnItem(swipe));
});

export default router;
