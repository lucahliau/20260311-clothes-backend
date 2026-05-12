import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { swipeLimiter } from "../middleware/rateLimit.js";
import { AppError } from "../middleware/error.js";
import { invalidateUserClusters } from "../services/feed-personalization.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const swipeSchema = z.object({
  itemId: z.string().uuid(),
  action: z.enum(["LOVE", "LIKE", "DISLIKE", "NEUTRAL"]),
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

  const existing = await prisma.swipe.findUnique({
    where: { userId_itemId: { userId, itemId } },
  });

  if (existing) {
    throw new AppError(409, "CONFLICT", "You have already swiped on this item");
  }

  const swipe = await prisma.swipe.create({
    data: { userId, itemId, action },
    include: { item: true },
  });

  invalidateUserClusters(userId);
  res.status(201).json(swipe);
});

// ---------------------------------------------------------------------------
// GET /swipes/history
// ---------------------------------------------------------------------------

router.get("/history", requireAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId: req.user!.userId };

  const actionFilter = req.query.action as string | undefined;
  if (actionFilter && ["LOVE", "LIKE", "DISLIKE", "NEUTRAL"].includes(actionFilter)) {
    where.action = actionFilter;
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
    swipes,
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
  res.json({ message: "Last swipe undone", undone: lastSwipe });
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
  res.json(swipe);
});

export default router;
