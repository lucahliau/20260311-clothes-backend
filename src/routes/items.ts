import { Router, Request, Response } from "express";
import { Prisma, type ClothingItem } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { cdnImageUrl, withCdnImages } from "../lib/imageCdn.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import {
  buildPersonalizedFeed,
  buildItemFilterSql,
  EMBEDDING_MODEL,
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

  // Relevance-ranked text search. The plain Prisma path below orders by
  // createdAt desc, so an exact brand/name hit loses to a fresher incidental
  // mention. When a search term is present, rank by match quality
  // (exact > prefix > contains) and tie-break by recency, backed by the pg_trgm
  // GIN indexes from migration 20260614000000_add_item_search_indexes.
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    const term = req.query.search.trim();
    // Escape LIKE wildcards so user input matches literally (parity with the
    // previous Prisma `contains`, which treats % / _ as literals).
    const escaped = term.replace(/[%_\\]/g, (m) => `\\${m}`);
    const like = `%${escaped}%`;
    const prefix = `${escaped}%`;

    const clauses: Prisma.Sql[] = [
      Prisma.sql`active = true`,
      // Hide classified non-wearables; NULL/unclassified stays visible.
      Prisma.sql`"isClothing" IS NOT FALSE`,
    ];
    if (req.query.category) clauses.push(Prisma.sql`category = ${String(req.query.category)}`);
    if (req.query.subcategory) clauses.push(Prisma.sql`subcategory = ${String(req.query.subcategory)}`);
    if (req.query.brand) clauses.push(Prisma.sql`brand = ${String(req.query.brand)}`);
    const sGender = parseGender(req.query.gender);
    if (sGender) {
      clauses.push(
        Array.isArray(sGender)
          ? Prisma.sql`gender IN (${Prisma.join(sGender)})`
          : Prisma.sql`gender = ${sGender}`,
      );
    }
    const sProductType = parseProductType(req.query.productType);
    if (sProductType) clauses.push(Prisma.sql`"productType" = ${sProductType}`);
    if (req.query.minPrice) clauses.push(Prisma.sql`price >= ${Number(req.query.minPrice)}`);
    if (req.query.maxPrice) clauses.push(Prisma.sql`price <= ${Number(req.query.maxPrice)}`);
    clauses.push(
      Prisma.sql`(name ILIKE ${like} OR description ILIKE ${like} OR brand ILIKE ${like})`,
    );
    const whereSql = Prisma.join(clauses, " AND ");

    const relevance = Prisma.sql`
      CASE
        WHEN lower(name) = lower(${term}) OR lower(brand) = lower(${term}) THEN 3
        WHEN name ILIKE ${prefix} OR brand ILIKE ${prefix} THEN 2
        WHEN name ILIKE ${like} THEN 1
        ELSE 0
      END`;

    const [idRows, countRows] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ClothingItem"
        WHERE ${whereSql}
        ORDER BY ${relevance} DESC, "createdAt" DESC
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "ClothingItem" WHERE ${whereSql}
      `,
    ]);

    const idOrder = idRows.map((r) => r.id);
    const found = idOrder.length
      ? await prisma.clothingItem.findMany({ where: { id: { in: idOrder } } })
      : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    const rankedItems = idOrder
      .map((id) => byId.get(id))
      .filter((x): x is ClothingItem => x !== undefined)
      .map(withCdnImages);
    const total = Number(countRows[0]?.count ?? 0);

    res.json({
      items: rankedItems,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
    return;
  }

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

  // Text search is handled by the relevance-ranked raw path above (returns early).

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
// GET /items/:id/similar  — "More like this" via CLIP image-embedding ANN
// ---------------------------------------------------------------------------

router.get("/:id/similar", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!UUID_REGEX.test(id)) {
    throw new AppError(400, "INVALID_ID", "Invalid item id");
  }
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));

  const filters: FeedFilters = {};
  const gender = parseGender(req.query.gender);
  if (gender) filters.gender = gender;

  // Nearest neighbours by cosine distance on the item's own CLIP image vector.
  // Reuses the feed's filter builder (active/hasNobg/isClothing/gender) and
  // excludes the source item. Mirrors the literal-vector cast the feed uses so
  // the HNSW index is hit. Falls back to same-brand recents when the item has
  // no embedding (only active+hasNobg items get embedded).
  let neighbourIds: string[] = [];
  try {
    const srcRows = await prisma.$queryRaw<{ vector: string }[]>`
      SELECT vector::text AS vector
      FROM "ItemEmbedding"
      WHERE "itemId" = ${id} AND model = ${EMBEDDING_MODEL}
      LIMIT 1
    `;
    const lit = srcRows[0]?.vector;
    if (lit) {
      const filterSql = Prisma.join(buildItemFilterSql([id], filters), " AND ");
      const rows = await prisma.$queryRaw<{ itemId: string }[]>`
        SELECT ie."itemId" AS "itemId"
        FROM "ItemEmbedding" ie
        JOIN "ClothingItem" ci ON ci.id = ie."itemId"
        WHERE ie.model = ${EMBEDDING_MODEL} AND ${filterSql}
        ORDER BY ie.vector <=> ${lit}::vector(512)
        LIMIT ${limit}
      `;
      neighbourIds = rows.map((r) => r.itemId);
    }
  } catch (err) {
    req.log.warn({ err }, "similar-items ANN query failed; falling back to brand");
  }

  if (neighbourIds.length > 0) {
    const found = await prisma.clothingItem.findMany({
      where: { id: { in: neighbourIds } },
    });
    const byId = new Map(found.map((r) => [r.id, r]));
    const items = neighbourIds
      .map((nid) => byId.get(nid))
      .filter((x): x is ClothingItem => x !== undefined)
      .map(toFeedItem);
    res.json({ items });
    return;
  }

  // Fallback: same brand, most recent, excluding self.
  const src = await prisma.clothingItem.findUnique({
    where: { id },
    select: { brand: true },
  });
  if (!src) {
    throw new AppError(404, "NOT_FOUND", "Item not found");
  }
  const fallback = src.brand
    ? await prisma.clothingItem.findMany({
        where: {
          active: true,
          id: { not: id },
          brand: src.brand,
          AND: [{ OR: [{ isClothing: true }, { isClothing: null }] }],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    : [];
  res.json({ items: fallback.map(toFeedItem) });
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
