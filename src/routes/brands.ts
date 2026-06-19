import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** Effectively “all brands” for distinct-brand listing; still capped to avoid abuse. */
const DEFAULT_LIST_LIMIT = 100_000;
const MAX_LIST_LIMIT = 500_000;
const DEFAULT_EXPLORE_LIMIT = 12;
/** Max rows returned by the random explore query (distinct brand groups). */
const MAX_EXPLORE_LIMIT = 100_000;

// ---------------------------------------------------------------------------
// GET /brands/explore
// ---------------------------------------------------------------------------

// The grouped (brand, count) rows only change when the crawler uploads, but the
// GROUP BY scans the whole catalog — cache the groups briefly and shuffle in JS
// per request so the response stays random.
const EXPLORE_CACHE_TTL_MS = 60_000;
let exploreCache: { rows: { brand: string; productCount: number }[]; expiresAt: number } | null =
  null;

async function getExploreBrandGroups(): Promise<{ brand: string; productCount: number }[]> {
  const now = Date.now();
  if (exploreCache && exploreCache.expiresAt > now) return exploreCache.rows;

  const rows = await prisma.$queryRaw<{ brand: string; productCount: bigint }[]>`
    SELECT brand, COUNT(*)::bigint AS "productCount"
    FROM "ClothingItem"
    WHERE active = true AND "hasPerson" IS NOT TRUE
    GROUP BY brand
  `;
  const mapped = rows.map((r) => ({ brand: r.brand, productCount: Number(r.productCount) }));
  exploreCache = { rows: mapped, expiresAt: now + EXPLORE_CACHE_TTL_MS };
  return mapped;
}

router.get("/explore", async (req: Request, res: Response) => {
  const limit = Math.min(
    MAX_EXPLORE_LIMIT,
    Math.max(1, Number(req.query.limit) || DEFAULT_EXPLORE_LIMIT),
  );

  const groups = await getExploreBrandGroups();

  // Fisher-Yates over a copy, then take the first `limit`.
  const shuffled = [...groups];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  res.setHeader("Cache-Control", "private, max-age=60");
  res.json({ brands: shuffled.slice(0, limit) });
});

// ---------------------------------------------------------------------------
// GET /brands/favorites  (the caller's saved brands, enriched with counts)
// ---------------------------------------------------------------------------

router.get("/favorites", requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { favoriteBrands: true },
  });
  const favorites = user?.favoriteBrands ?? [];
  if (favorites.length === 0) {
    res.json({ brands: [] });
    return;
  }

  const grouped = await prisma.clothingItem.groupBy({
    by: ["brand"],
    where: { active: true, brand: { in: favorites, mode: "insensitive" } },
    _count: { _all: true },
  });
  const countByBrand = new Map(grouped.map((g) => [g.brand.toLowerCase(), g._count._all]));

  res.json({
    brands: favorites.map((brand) => ({
      brand,
      productCount: countByBrand.get(brand.toLowerCase()) ?? 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// PUT /brands/favorites  { brand, favorite }  — set saved state for one brand
// ---------------------------------------------------------------------------
// Body (not a path param) so brand names with spaces/slashes need no encoding.

const setFavoriteSchema = z.object({
  brand: z.string().trim().min(1).max(200),
  favorite: z.boolean(),
});

router.put("/favorites", requireAuth, async (req: Request, res: Response) => {
  const { brand, favorite } = setFavoriteSchema.parse(req.body);
  const userId = req.user!.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { favoriteBrands: true },
  });
  const current = user?.favoriteBrands ?? [];
  const withoutBrand = current.filter((b) => b.toLowerCase() !== brand.toLowerCase());
  const next = favorite ? [...withoutBrand, brand] : withoutBrand;

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { favoriteBrands: next },
    select: { favoriteBrands: true },
  });

  res.json({ favoriteBrands: updated.favoriteBrands });
});

// ---------------------------------------------------------------------------
// GET /brands  (distinct brands, optional prefix search)
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Number(req.query.limit) || DEFAULT_LIST_LIMIT),
  );
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where: Prisma.ClothingItemWhereInput = { active: true };
  if (q) {
    where.brand = { contains: q, mode: "insensitive" };
  }

  const grouped = await prisma.clothingItem.groupBy({
    by: ["brand"],
    where,
    _count: { _all: true },
    orderBy: { brand: "asc" },
    take: limit,
  });

  res.json({
    brands: grouped.map((g) => ({
      brand: g.brand,
      productCount: g._count._all,
    })),
  });
});

export default router;
