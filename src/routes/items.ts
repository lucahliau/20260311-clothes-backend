import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { getNobgUrl, nobgExists } from "../lib/images.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const FETCH_MULTIPLIER = 10;

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

  const excludeIds = swipedItemIds.map((s: { itemId: string }) => s.itemId);

  const where: Record<string, unknown> = {
    active: true,
    ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
  };

  if (req.query.category) where.category = req.query.category;
  if (req.query.gender) where.gender = req.query.gender;

  const r2BaseUrl = env().R2_PUBLIC_URL;
  const fetchSize = r2BaseUrl ? limit * FETCH_MULTIPLIER : limit;

  let items = await prisma.clothingItem.findMany({
    where,
    take: fetchSize,
    orderBy: { createdAt: "desc" },
  });

  if (r2BaseUrl) {
    const checks = await Promise.all(
      items.map(async (item) => {
        const nobgUrl = getNobgUrl(item.imageUrl, r2BaseUrl);
        if (!nobgUrl) return false;
        return nobgExists(nobgUrl);
      })
    );
    items = items.filter((_, i) => checks[i]).slice(0, limit);
  }

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
    throw new AppError(404, "NOT_FOUND", "Item not found");
  }

  res.json(item);
});

export default router;
