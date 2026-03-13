import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// GET /items
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { active: true };

  if (req.query.category) where.category = req.query.category;
  if (req.query.subcategory) where.subcategory = req.query.subcategory;
  if (req.query.brand) where.brand = req.query.brand;
  if (req.query.gender) where.gender = req.query.gender;

  if (req.query.minPrice || req.query.maxPrice) {
    const price: Record<string, number> = {};
    if (req.query.minPrice) price.gte = Number(req.query.minPrice);
    if (req.query.maxPrice) price.lte = Number(req.query.maxPrice);
    where.price = price;
  }

  if (req.query.search) {
    const term = String(req.query.search);
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.clothingItem.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.clothingItem.count({ where }),
  ]);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /items/feed
// ---------------------------------------------------------------------------

router.get("/feed", requireAuth, async (req: Request, res: Response) => {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const userId = req.user!.userId;

  const swipedItemIds = await prisma.swipe.findMany({
    where: { userId },
    select: { itemId: true },
  });

  const excludeIds = swipedItemIds.map((s) => s.itemId);

  const where: Record<string, unknown> = {
    active: true,
    ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
  };

  if (req.query.category) where.category = req.query.category;
  if (req.query.gender) where.gender = req.query.gender;

  const items = await prisma.clothingItem.findMany({
    where,
    take: limit,
    orderBy: { createdAt: "desc" },
  });

  res.json({ items, remaining: items.length });
});

// ---------------------------------------------------------------------------
// GET /items/:id
// ---------------------------------------------------------------------------

router.get("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const item = await prisma.clothingItem.findUnique({
    where: { id, active: true },
  });

  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  res.json(item);
});

export default router;
