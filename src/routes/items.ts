import { Router, Request, Response } from "express";
import { Prisma, type ClothingItem } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { cdnImageUrl, withCdnImages } from "../lib/imageCdn.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import {
  buildPersonalizedFeed,
  type FeedFilters,
  type FeedMatch,
} from "../services/feed-personalization.js";

/** Wire shape for feed items: only the fields the iOS `Item` model actually
 * reads (all its keys decode via decodeIfPresent, so dropping unused columns —
 * metadata, externalId, manufacturerCode, lastVerifiedAt, subcategory, sizes,
 * tags, active, updatedAt, hasNobg — is additive-safe for shipped builds and
 * cuts payload + client decode time). */
function toFeedItem(item: ClothingItem) {
  const slim = {
    id: item.id,
    name: item.name,
    description: item.description,
    brand: item.brand,
    category: item.category,
    price: item.price,
    currency: item.currency,
    imageUrl: item.imageUrl,
    images: item.images,
    colors: item.colors,
    gender: item.gender,
    productType: item.productType,
    sourceUrl: item.sourceUrl,
    retailer: item.retailer,
    createdAt: item.createdAt,
  };
  return withCdnImages(slim);
}

/** Rewrite contributor thumbnails ("because you liked…" UI) onto the CDN too. */
function toWireMatch(match: FeedMatch): FeedMatch {
  return {
    ...match,
    topContributors: match.topContributors.map((c) => ({
      ...c,
      imageUrl: cdnImageUrl(c.imageUrl) ?? c.imageUrl,
    })),
  };
}

const router = Router();

/** Page caps. The iOS app always sends an explicit `limit` and pages on
 * `pagination.totalPages` (computed from the effective limit), so clamping
 * here yields more, smaller pages — never silent truncation. */
const DEFAULT_PAGE_SIZE = 100;
const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 200;
const MAX_EXCLUDE_IDS = 1000; // cap notIn size to avoid query timeouts
// UUID v4 format: 8-4-4-4-12
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 10_000;

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

/** Defense-in-depth: derive a gender filter from the signed-in user's profile
 * gender when the client didn't send one, so the feed is gender-correct even if
 * a client forgets the param. Mirrors the iOS default (male→[male,unisex]). */
function profileGenderToFilter(profileGender: string | null | undefined): string[] | null {
  const g = (profileGender ?? "").trim().toLowerCase();
  if (g === "male" || g === "man" || g === "men") return ["male", "unisex"];
  if (g === "female" || g === "woman" || g === "women") return ["female", "unisex"];
  return null; // non-binary / unset / "everything" → no gender filter
}

// ---------------------------------------------------------------------------
// GET /items
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;

  const where: Prisma.ClothingItemWhereInput = { active: true };

  // Hide classified non-wearables; NULL/unclassified stays visible. Prisma's
  // field-level `not` excludes NULLs, so spell out the OR explicitly. Use AND[]
  // so it composes with the search OR (a second top-level OR would clobber it).
  const and: Prisma.ClothingItemWhereInput[] = [
    { OR: [{ isClothing: true }, { isClothing: null }] },
  ];

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
    and.push({
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
        { brand: { contains: term, mode: "insensitive" } },
      ],
    });
  }

  where.AND = and;

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
    items: items.map(withCdnImages),
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
  const limit = Math.min(
    FEED_MAX_LIMIT,
    Math.max(1, Number(req.query.limit) || FEED_DEFAULT_LIMIT),
  );
  const userId = req.user!.userId;

  const filters: FeedFilters = {};
  if (typeof req.query.category === "string" && req.query.category.trim()) {
    filters.category = req.query.category.trim();
  }
  const gender = parseGender(req.query.gender);
  if (gender) {
    filters.gender = gender;
  } else {
    // Client sent no gender filter — fall back to the user's profile gender so
    // a male user never gets women's items (and vice versa) by omission.
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { gender: true },
    });
    const profileFilter = profileGenderToFilter(profile?.gender);
    if (profileFilter) filters.gender = profileFilter;
  }
  const productType = parseProductType(req.query.productType);
  if (productType) filters.productType = productType;

  // Try the personalized path; fall back to a preference-agnostic random feed
  // if anything in the embedding pipeline fails (missing pgvector index, DB
  // error, etc.) so /items/feed never goes empty for an avoidable reason.
  try {
    const entries = await buildPersonalizedFeed({ userId, limit, filters });
    if (entries.length > 0) {
      const items = entries.map((e) => toFeedItem(e.item));
      const matches: FeedMatch[] = entries.map((e) => toWireMatch(e.match));
      res.json({ items, matches, remaining: items.length });
      return;
    }
  } catch (err) {
    req.log.warn({ err }, "buildPersonalizedFeed failed, falling back to random feed");
  }

  // Fallback: original random feed (no embeddings required).
  const swipedItemIds = await prisma.swipe.findMany({
    where: { userId },
    select: { itemId: true },
    orderBy: { createdAt: "desc" },
    take: MAX_EXCLUDE_IDS,
  });
  const excludeIds = swipedItemIds.map((s) => s.itemId).filter((id) => UUID_REGEX.test(id));

  const sqlWhere: Prisma.Sql[] = [
    Prisma.sql`active = true`,
    Prisma.sql`"hasNobg" = true`,
    Prisma.sql`"isClothing" IS NOT FALSE`,
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
    res.json({ items: [], matches: [], remaining: 0 });
    return;
  }

  const rows = await prisma.clothingItem.findMany({
    where: { id: { in: idOrder } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = idOrder
    .map((id) => byId.get(id))
    .filter((x): x is ClothingItem => x !== undefined)
    .map(toFeedItem);

  // Fallback path has no embedding/clustering signal, so all matches are
  // tagged as random so the client still gets a coherent response shape.
  const matches: FeedMatch[] = items.map((item) => ({
    itemId: item.id,
    source: "random",
    clusterIndex: null,
    clusterSim: null,
    scorePct: null,
    bucket: null,
    topContributors: [],
  }));

  res.json({ items, matches, remaining: items.length });
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

  res.json(withCdnImages(item));
});

export default router;
