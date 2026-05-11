import { Router, Request, Response } from "express";
import { Prisma, type ClothingItem } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { buildPersonalizedFeed, type FeedFilters } from "../services/feed-personalization.js";

const router = Router();

/** High ceiling for `limit`; default is large so search/brand views are rarely truncated. Use `page` for bigger catalogs. */
const DEFAULT_PAGE_SIZE = 50_000;
const FEED_DEFAULT_LIMIT = 50;
const MAX_EXCLUDE_IDS = 1000; // cap notIn size to avoid query timeouts
// UUID v4 format: 8-4-4-4-12
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 500_000;

const VALID_GENDERS = new Set(["male", "female", "unisex", "men", "women"]);
const VALID_PRODUCT_TYPES = new Set(["tops", "bottoms", "bags", "accessories", "jackets", "other"]);

function parseGender(val: unknown): string | string[] | null {
  if (typeof val !== "string" || !val.trim()) return null;
  const g = val.trim().toLowerCase();
  if (!VALID_GENDERS.has(g)) return null;
  if (g === "men") return ["male", "men"];
  if (g === "women") return ["female", "women"];
  return g;
}

function parseProductType(val: unknown): string | null {
  if (typeof val !== "string" || !val.trim()) return null;
  const p = val.trim().toLowerCase();
  return VALID_PRODUCT_TYPES.has(p) ? p : null;
}

// ---------------------------------------------------------------------------
// GET /items
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;

  const where: Prisma.ClothingItemWhereInput = { active: true };

  if (req.query.category) where.category = String(req.query.category);
  if (req.query.subcategory) where.subcategory = String(req.query.subcategory);
  if (req.query.brand) where.brand = String(req.query.brand);
  const gender = parseGender(req.query.gender);
  if (gender) where.gender = Array.isArray(gender) ? { in: gender } : gender;
  const productType = parseProductType(req.query.productType);
  if (productType) where.productType = productType;

  if (req.query.minPrice || req.query.maxPrice) {
    const price: Prisma.DecimalFilter = {};
    if (req.query.minPrice) price.gte = Number(req.query.minPrice);
    if (req.query.maxPrice) price.lte = Number(req.query.maxPrice);
    where.price = price;
  }

  if (req.query.search) {
    const term = String(req.query.search);
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } },
      { brand: { contains: term, mode: "insensitive" } },
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
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || FEED_DEFAULT_LIMIT));
  const userId = req.user!.userId;

  const filters: FeedFilters = {};
  if (typeof req.query.category === "string" && req.query.category.trim()) {
    filters.category = req.query.category.trim();
  }
  const gender = parseGender(req.query.gender);
  if (gender) filters.gender = gender;
  const productType = parseProductType(req.query.productType);
  if (productType) filters.productType = productType;

  // Try the personalized path; fall back to a preference-agnostic random feed
  // if anything in the embedding pipeline fails (missing pgvector index, DB
  // error, etc.) so /items/feed never goes empty for an avoidable reason.
  try {
    const items = await buildPersonalizedFeed({ userId, limit, filters });
    if (items.length > 0) {
      res.json({ items, remaining: items.length });
      return;
    }
  } catch (err) {
    console.error("buildPersonalizedFeed failed, falling back to random feed", err);
  }

  // Fallback: original random feed (no embeddings required).
  const swipedItemIds = await prisma.swipe.findMany({
    where: { userId },
    select: { itemId: true },
    orderBy: { createdAt: "desc" },
    take: MAX_EXCLUDE_IDS,
  });
  const excludeIds = swipedItemIds
    .map((s) => s.itemId)
    .filter((id) => UUID_REGEX.test(id));

  const sqlWhere: Prisma.Sql[] = [
    Prisma.sql`active = true`,
    Prisma.sql`"hasNobg" = true`,
  ];
  if (excludeIds.length > 0) {
    sqlWhere.push(Prisma.sql`id NOT IN (${Prisma.join(excludeIds)})`);
  }
  if (filters.category) sqlWhere.push(Prisma.sql`category = ${filters.category}`);
  if (filters.gender) {
    if (Array.isArray(filters.gender)) {
      sqlWhere.push(Prisma.sql`gender IN (${Prisma.join(filters.gender)})`);
    } else {
      sqlWhere.push(Prisma.sql`gender = ${filters.gender}`);
    }
  }
  if (filters.productType) sqlWhere.push(Prisma.sql`"productType" = ${filters.productType}`);

  const idRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "ClothingItem"
    WHERE ${Prisma.join(sqlWhere, " AND ")}
    ORDER BY RANDOM()
    LIMIT ${limit}
  `;

  const idOrder = idRows.map((r) => r.id);
  if (idOrder.length === 0) {
    res.json({ items: [], remaining: 0 });
    return;
  }

  const rows = await prisma.clothingItem.findMany({
    where: { id: { in: idOrder } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: ClothingItem[] = idOrder
    .map((id) => byId.get(id))
    .filter((x): x is ClothingItem => x !== undefined);

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
