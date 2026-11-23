import { Prisma } from "../../generated/prisma/client.js";

/** Sort orders accepted by GET /items (non-search path). */
export type ItemSort = "newest" | "price_asc" | "price_desc";

const ITEM_SORTS = new Set<ItemSort>(["newest", "price_asc", "price_desc"]);

/** Unknown/absent values fall back to `newest` (the pre-existing behaviour). */
export function parseItemSort(val: unknown): ItemSort {
  if (typeof val !== "string") return "newest";
  const s = val.trim().toLowerCase() as ItemSort;
  return ITEM_SORTS.has(s) ? s : "newest";
}

/** ORDER BY body for GET /items. Price sorts use the effective price (salePrice
 * when present, else price), push NULL prices last in both directions, and
 * tie-break on id so OFFSET pagination is stable. */
export function itemOrderBySql(sort: ItemSort): Prisma.Sql {
  switch (sort) {
    case "price_asc":
      return Prisma.sql`COALESCE("salePrice", price) ASC NULLS LAST, id ASC`;
    case "price_desc":
      return Prisma.sql`COALESCE("salePrice", price) DESC NULLS LAST, id ASC`;
    default:
      return Prisma.sql`"createdAt" DESC, id ASC`;
  }
}

/** Opt-in boolean query flag: only "true"/"1" (any case) count as on. */
export function parseBooleanFlag(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "1";
}

/** `minProducts` for GET /brands: a positive integer, else null (no filter). */
export function parseMinProducts(val: unknown): number | null {
  if (typeof val !== "string" || !/^\d+$/.test(val.trim())) return null;
  const n = Number(val.trim());
  return Number.isSafeInteger(n) && n > 1 ? n : null;
}
