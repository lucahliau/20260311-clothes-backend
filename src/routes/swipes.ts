import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const swipeSchema = z.object({
  itemId: z.string().uuid(),
  action: z.enum(["LIKE", "PASS", "SUPERLIKE"]),
});

// ---------------------------------------------------------------------------
// POST /swipes
// ---------------------------------------------------------------------------

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = swipeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { itemId, action } = parsed.data;
  const userId = req.user!.userId;

  const item = await prisma.clothingItem.findUnique({ where: { id: itemId, active: true } });
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  const existing = await prisma.swipe.findUnique({
    where: { userId_itemId: { userId, itemId } },
  });

  if (existing) {
    res.status(409).json({ error: "You have already swiped on this item" });
    return;
  }

  const swipe = await prisma.swipe.create({
    data: { userId, itemId, action },
    include: { item: true },
  });

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
  if (actionFilter && ["LIKE", "PASS", "SUPERLIKE"].includes(actionFilter)) {
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
    res.status(404).json({ error: "No swipes to undo" });
    return;
  }

  await prisma.swipe.delete({ where: { id: lastSwipe.id } });

  res.json({ message: "Last swipe undone", undone: lastSwipe });
});

export default router;
