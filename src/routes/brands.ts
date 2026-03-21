import { Router, Request, Response } from "express";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

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

router.get("/explore", async (req: Request, res: Response) => {
  const limit = Math.min(MAX_EXPLORE_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_EXPLORE_LIMIT));

  const rows = await prisma.$queryRaw<{ brand: string; productCount: bigint }[]>`
    SELECT brand, COUNT(*)::bigint AS "productCount"
    FROM "ClothingItem"
    WHERE active = true
    GROUP BY brand
    ORDER BY RANDOM()
    LIMIT ${limit}
  `;

  res.json({
    brands: rows.map((r) => ({
      brand: r.brand,
      productCount: Number(r.productCount),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /brands  (distinct brands, optional prefix search)
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIST_LIMIT));
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
