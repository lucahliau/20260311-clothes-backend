/**
 * Personalized feed: multi-interest clustering over CLIP embeddings.
 *
 * Pipeline: build user interest clusters from positive swipes → retrieve
 * candidates per cluster via pgvector ANN → score (cluster sim + dislike
 * repulsion + brand/style match + jitter) → diversify via per-cluster
 * round-robin → interleave exploration items.
 *
 * Falls back to a preference-filtered random feed when the user has too few
 * positive swipes with embeddings to cluster meaningfully (cold start).
 *
 * In addition to producing an ordered list of items, this module surfaces
 * per-card match metadata (source, clusterSim, calibrated %, bucket, and the
 * top liked items that built the matching cluster) so the client can render a
 * match-likelihood badge and an explainer.
 */

import { Prisma, type ClothingItem } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { sphericalKMeans, normalize, dot, pickK, type Vector } from "../lib/kmeans.js";

export const EMBEDDING_MODEL = "clip-vit-b-32-image";

// History windows
const MAX_POSITIVE_HISTORY = 200;
const MAX_NEGATIVE_HISTORY = 100;
const MIN_POSITIVE_FOR_PERSONALIZATION = 5;
const HALF_LIFE_DAYS = 30;
const LOVE_WEIGHT = 2.0;
const LIKE_WEIGHT = 1.0;

// Retrieval / scoring
const CANDIDATES_PER_CLUSTER = 80;
const W_CLUSTER = 1.0;
const W_DISLIKE = 0.3;
const W_BRAND = 0.1;
const W_STYLE = 0.05;
const STYLE_MATCH_CAP = 3; // cap |tags ∩ stylePreferences| contribution
const JITTER_RANGE = 0.05;

// Exploration mix
const PERSONALIZED_FRACTION = 0.7;
const NOVELTY_FRACTION = 0.15;
// remainder is pure random

// Caching
const CLUSTER_TTL_MS = 5 * 60 * 1000;

// Match explainer
const TOP_CONTRIBUTORS_PER_CLUSTER = 5;

// Calibrated display %: logistic curve over cosine similarity. CLIP ViT-B/32
// image embeddings are highly anisotropic, so real centroid↔item cosine sims
// live in a narrow high band (measured: personalized candidates ~0.86–0.97,
// novelty ~0.37–0.82). A linear window saturated everything to one rail, so we
// use a sigmoid centered/sloped to spread that band across the display range:
// personalized → ~28–84%, novelty → ~5–13%.
const CALIB_MIDPOINT = 0.9; // sim mapped to 50%
const CALIB_SLOPE = 24; // steepness around the midpoint
const MIN_DISPLAY_PCT = 5;
const MAX_DISPLAY_PCT = 99;

// Bucket cutoffs operate on the calibrated %, so they can't re-saturate.
const BUCKET_HIGH_MIN_PCT = 66;
const BUCKET_MEDIUM_MIN_PCT = 33;

// ---------- vector (de)serialization ----------

function parseVector(s: string): Vector {
  // pgvector returns vectors as text: "[0.1,-0.2,...]"
  const trimmed = s.startsWith("[") ? s.slice(1, -1) : s;
  const parts = trimmed.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

function vectorToLiteral(v: Vector): string {
  // pgvector accepts the same text format on input
  return "[" + Array.from(v).join(",") + "]";
}

// ---------- types ----------

export type MatchSource = "personalized" | "novelty" | "random" | "cold_start";
export type MatchBucket = "high" | "medium" | "low";

export type ClusterContributor = {
  itemId: string;
  name: string;
  imageUrl: string | null;
  sim: number;
};

export type FeedMatch = {
  itemId: string;
  source: MatchSource;
  clusterIndex: number | null;
  clusterSim: number | null;
  scorePct: number | null;
  bucket: MatchBucket | null;
  topContributors: ClusterContributor[];
};

export type FeedEntry = {
  item: ClothingItem;
  match: FeedMatch;
};

// ---------- calibration ----------

export function calibrateScorePct(sim: number): number {
  const pct = 100 / (1 + Math.exp(-CALIB_SLOPE * (sim - CALIB_MIDPOINT)));
  return Math.max(MIN_DISPLAY_PCT, Math.min(MAX_DISPLAY_PCT, Math.round(pct)));
}

export function bucketForScorePct(pct: number): MatchBucket {
  if (pct >= BUCKET_HIGH_MIN_PCT) return "high";
  if (pct >= BUCKET_MEDIUM_MIN_PCT) return "medium";
  return "low";
}

export function bucketForClusterSim(sim: number): MatchBucket {
  return bucketForScorePct(calibrateScorePct(sim));
}

// ---------- cluster cache ----------

type UserClusters = {
  clusters: { centroid: Vector; weight: number; topContributors: ClusterContributor[] }[];
  dislikeCentroid: Vector | null;
  positiveCount: number;
  computedAt: number;
};

// Bounded LRU (insertion-ordered Map; the oldest key is least-recently-used).
// Capped so a growing user base can't leak memory on a long-lived process — a
// cold miss just rebuilds that user's clusters on their next feed fetch.
const clusterCache = new Map<string, UserClusters>();
const MAX_CACHED_USERS = 5000;
// Users whose clusters are known to be out of date (a swipe landed since the
// cached build). Tracked separately so we never DROP the cached clusters.
const dirtyUsers = new Set<string>();
// One build per user at a time — dedupes concurrent feed requests (and a
// foreground cold-start request racing a background refresh).
const inflightBuilds = new Map<string, Promise<UserClusters>>();

/** Insert/refresh a user's clusters, evicting the least-recently-used entry
 *  once the cache exceeds MAX_CACHED_USERS. */
function cacheUserClusters(userId: string, clusters: UserClusters): void {
  clusterCache.set(userId, clusters);
  if (clusterCache.size > MAX_CACHED_USERS) {
    const oldest = clusterCache.keys().next().value;
    if (oldest !== undefined && oldest !== userId) {
      clusterCache.delete(oldest);
      dirtyUsers.delete(oldest);
    }
  }
}

/** Read a user's cached clusters, bumping the entry to most-recently-used so
 *  active users aren't evicted ahead of idle ones. */
function readUserClusters(userId: string): UserClusters | undefined {
  const entry = clusterCache.get(userId);
  if (entry) {
    clusterCache.delete(userId);
    clusterCache.set(userId, entry);
  }
  return entry;
}

/** Fire-and-forget cluster warm-up for launch-adjacent endpoints (/users/me):
 * after a process restart or LRU eviction, the ~3s k-means + ANN cold build
 * runs during the app's splash instead of blocking the first /items/feed.
 * No-op when a cached entry exists; startClusterBuild dedupes concurrent
 * callers and swallows failures (the feed's own fallback still applies). */
export function warmUserClusters(userId: string): void {
  if (!readUserClusters(userId)) void startClusterBuild(userId);
}

export function invalidateUserClusters(userId: string): void {
  // Stale-while-revalidate: do NOT delete the cached clusters. Dropping them
  // forces the next /items/feed to recompute k-means + per-cluster ANN
  // synchronously — the ~3s stall users hit after a few swipes. Instead mark the
  // entry dirty so getUserClusters serves it immediately and refreshes in the
  // background. If nothing is cached yet, the next call cold-builds anyway.
  if (clusterCache.has(userId)) dirtyUsers.add(userId);
}

/**
 * Build (or rebuild) a user's clusters, populating the cache on success. Dedupes
 * via inflightBuilds so concurrent callers share one build. The returned promise
 * rejects on failure (foreground cold-start awaiters fall back to a random
 * feed); a detached `.catch` keeps a background rebuild's rejection from
 * surfacing as an unhandledRejection and leaves the stale entry in place.
 */
function startClusterBuild(userId: string): Promise<UserClusters> {
  const existing = inflightBuilds.get(userId);
  if (existing) return existing;
  const p = buildUserClusters(userId).then((fresh) => {
    cacheUserClusters(userId, fresh);
    dirtyUsers.delete(userId);
    return fresh;
  });
  inflightBuilds.set(userId, p);
  p.catch(() => {
    // Keep any stale entry; clear dirty so we don't hot-loop a failing rebuild
    // on every feed fetch (the TTL will prompt another attempt later).
    dirtyUsers.delete(userId);
  }).finally(() => {
    inflightBuilds.delete(userId);
  });
  return p;
}

// ---------- helpers ----------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeedFilters = {
  category?: string;
  gender?: string | string[];
  productType?: string;
};

function recencyWeight(createdAt: Date, now: number): number {
  const ageDays = (now - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function buildItemFilterSql(excludeIds: string[], filters: FeedFilters): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`ci.active = true`,
    Prisma.sql`ci."hasNobg" = true`,
    // Hide classified non-wearables; NULL (unclassified) stays visible.
    Prisma.sql`ci."isClothing" IS NOT FALSE`,
    // Hide products whose only photos are of a model/person; NULL (unscanned)
    // stays visible.
    Prisma.sql`ci."hasPerson" IS NOT TRUE`,
  ];
  if (excludeIds.length > 0) {
    clauses.push(Prisma.sql`ci.id NOT IN (${Prisma.join(excludeIds)})`);
  }
  if (filters.category) clauses.push(Prisma.sql`ci.category = ${filters.category}`);
  if (filters.gender) {
    if (Array.isArray(filters.gender)) {
      clauses.push(Prisma.sql`ci.gender IN (${Prisma.join(filters.gender)})`);
    } else {
      clauses.push(Prisma.sql`ci.gender = ${filters.gender}`);
    }
  }
  if (filters.productType) clauses.push(Prisma.sql`ci."productType" = ${filters.productType}`);
  return clauses;
}

function firstImageUrl(imageUrl: string | null, images: string[] | null): string | null {
  if (imageUrl && imageUrl.length > 0) return imageUrl;
  if (images && images.length > 0) return images[0] ?? null;
  return null;
}

// ---------- build user clusters ----------

async function buildUserClusters(userId: string): Promise<UserClusters> {
  const now = Date.now();
  // Positive swipes joined with embeddings and item rows so we can later show
  // "you liked these N items" alongside each personalized card.
  const positiveRows = await prisma.$queryRaw<
    {
      itemId: string;
      action: "LOVE" | "LIKE";
      createdAt: Date;
      vector: string;
      name: string;
      imageUrl: string | null;
      images: string[];
    }[]
  >`
    SELECT s."itemId" AS "itemId",
           s.action::text AS action,
           s."createdAt",
           ie.vector::text AS vector,
           ci.name AS name,
           ci."imageUrl" AS "imageUrl",
           ci.images AS images
    FROM "Swipe" s
    JOIN "ItemEmbedding" ie
      ON ie."itemId" = s."itemId" AND ie.model = ${EMBEDDING_MODEL}
    JOIN "ClothingItem" ci
      ON ci.id = s."itemId"
    WHERE s."userId" = ${userId} AND s.action IN ('LOVE', 'LIKE')
    ORDER BY s."createdAt" DESC
    LIMIT ${MAX_POSITIVE_HISTORY}
  `;

  if (positiveRows.length < MIN_POSITIVE_FOR_PERSONALIZATION) {
    return {
      clusters: [],
      dislikeCentroid: null,
      positiveCount: positiveRows.length,
      computedAt: now,
    };
  }

  const points: Vector[] = [];
  const weights: number[] = [];
  for (const row of positiveRows) {
    const v = normalize(parseVector(row.vector));
    const swipeWeight = row.action === "LOVE" ? LOVE_WEIGHT : LIKE_WEIGHT;
    points.push(v);
    weights.push(swipeWeight * recencyWeight(row.createdAt, now));
  }

  const k = pickK(points.length);
  const {
    centroids,
    assignments,
    weights: clusterWeights,
  } = sphericalKMeans(points, k, weights, {
    seed: hashStringToInt(userId),
  });

  // For each cluster, gather contributors and rank by cosine similarity to its
  // centroid so the explainer surfaces the most representative liked items.
  const contributorsByCluster: ClusterContributor[][] = Array.from(
    { length: centroids.length },
    () => [],
  );
  for (let i = 0; i < points.length; i++) {
    const ci = assignments[i] ?? 0;
    const sim = dot(points[i]!, centroids[ci]!);
    const row = positiveRows[i]!;
    contributorsByCluster[ci]!.push({
      itemId: row.itemId,
      name: row.name,
      imageUrl: firstImageUrl(row.imageUrl, row.images),
      sim,
    });
  }
  for (const arr of contributorsByCluster) arr.sort((a, b) => b.sim - a.sim);

  const clusters = centroids.map((centroid, i) => ({
    centroid,
    weight: clusterWeights[i] ?? 0,
    topContributors: contributorsByCluster[i]!.slice(0, TOP_CONTRIBUTORS_PER_CLUSTER),
  }));

  // Dislike centroid (single vector; weighted mean of recent DISLIKEs).
  const dislikeRows = await prisma.$queryRaw<{ createdAt: Date; vector: string }[]>`
    SELECT s."createdAt", ie.vector::text AS vector
    FROM "Swipe" s
    JOIN "ItemEmbedding" ie
      ON ie."itemId" = s."itemId" AND ie.model = ${EMBEDDING_MODEL}
    WHERE s."userId" = ${userId} AND s.action = 'DISLIKE'
    ORDER BY s."createdAt" DESC
    LIMIT ${MAX_NEGATIVE_HISTORY}
  `;

  let dislikeCentroid: Vector | null = null;
  if (dislikeRows.length > 0) {
    const dim = dislikeRows[0]!.vector.startsWith("[")
      ? parseVector(dislikeRows[0]!.vector).length
      : 512;
    const sum = new Float32Array(dim);
    let totalW = 0;
    for (const row of dislikeRows) {
      const v = normalize(parseVector(row.vector));
      const w = recencyWeight(row.createdAt, now);
      for (let i = 0; i < dim; i++) sum[i] = sum[i]! + v[i]! * w;
      totalW += w;
    }
    if (totalW > 0) dislikeCentroid = normalize(sum);
  }

  return { clusters, dislikeCentroid, positiveCount: points.length, computedAt: now };
}

function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

async function getUserClusters(userId: string): Promise<UserClusters> {
  const cached = readUserClusters(userId);
  if (cached) {
    const stale = Date.now() - cached.computedAt >= CLUSTER_TTL_MS;
    // Refresh in the background but serve the (possibly stale) clusters now so
    // the feed fetch stays fast. startClusterBuild's in-flight guard makes
    // repeated triggers cheap.
    if (stale || dirtyUsers.has(userId)) void startClusterBuild(userId);
    return cached;
  }
  // Cold start: nothing cached yet, so we must build before personalizing.
  return startClusterBuild(userId);
}

// ---------- candidate retrieval ----------

type Candidate = {
  itemId: string;
  clusterIndex: number;
  clusterSim: number; // 1 - cosine distance (higher = more similar)
};

async function retrieveCandidatesPerCluster(
  clusters: { centroid: Vector }[],
  excludeIds: string[],
  filters: FeedFilters,
): Promise<Candidate[]> {
  const filterClauses = buildItemFilterSql(excludeIds, filters);
  const filterSql = Prisma.join(filterClauses, " AND ");

  const perCluster = await Promise.all(
    clusters.map(async (cluster, idx) => {
      const lit = vectorToLiteral(cluster.centroid);
      const rows = await prisma.$queryRaw<{ itemId: string; dist: number }[]>`
        SELECT ie."itemId" AS "itemId",
               (ie.vector <=> ${lit}::vector(512))::float8 AS dist
        FROM "ItemEmbedding" ie
        JOIN "ClothingItem" ci ON ci.id = ie."itemId"
        WHERE ie.model = ${EMBEDDING_MODEL} AND ${filterSql}
        ORDER BY ie.vector <=> ${lit}::vector(512)
        LIMIT ${CANDIDATES_PER_CLUSTER}
      `;
      return rows.map((r) => ({
        itemId: r.itemId,
        clusterIndex: idx,
        clusterSim: 1 - Number(r.dist),
      }));
    }),
  );

  // Union, keep the best (highest sim) cluster assignment per item.
  const byItem = new Map<string, Candidate>();
  for (const cluster of perCluster) {
    for (const c of cluster) {
      const existing = byItem.get(c.itemId);
      if (!existing || c.clusterSim > existing.clusterSim) byItem.set(c.itemId, c);
    }
  }
  return Array.from(byItem.values());
}

async function dislikeDistancesFor(
  itemIds: string[],
  dislikeCentroid: Vector,
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const lit = vectorToLiteral(dislikeCentroid);
  const rows = await prisma.$queryRaw<{ itemId: string; dist: number }[]>`
    SELECT ie."itemId" AS "itemId",
           (ie.vector <=> ${lit}::vector(512))::float8 AS dist
    FROM "ItemEmbedding" ie
    WHERE ie.model = ${EMBEDDING_MODEL}
      AND ie."itemId" IN (${Prisma.join(itemIds)})
  `;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.itemId, Number(r.dist));
  return out;
}

// ---------- scoring + diversification ----------

type ScoredCandidate = Candidate & { score: number };

export function scoreCandidates(
  candidates: Candidate[],
  itemsById: Map<string, ClothingItem>,
  user: { stylePreferences: string[]; favoriteBrands: string[] },
  dislikeDistByItem: Map<string, number>,
  rand: () => number,
): ScoredCandidate[] {
  const styleSet = new Set(user.stylePreferences.map((s) => s.toLowerCase()));
  const brandSet = new Set(user.favoriteBrands.map((s) => s.toLowerCase()));

  return candidates
    .map((c) => {
      const item = itemsById.get(c.itemId);
      if (!item) return null;
      let score = W_CLUSTER * c.clusterSim;

      const dDist = dislikeDistByItem.get(c.itemId);
      if (typeof dDist === "number") {
        score -= W_DISLIKE * (1 - dDist);
      }

      if (brandSet.has(item.brand.toLowerCase())) score += W_BRAND;

      let styleMatches = 0;
      for (const t of item.tags) if (styleSet.has(t.toLowerCase())) styleMatches++;
      if (styleMatches > 0) score += W_STYLE * Math.min(styleMatches, STYLE_MATCH_CAP);

      score += rand() * JITTER_RANGE;

      return { ...c, score };
    })
    .filter((x): x is ScoredCandidate => x !== null);
}

/**
 * Per-cluster round-robin: cycle through clusters, picking the best-remaining
 * candidate from each. Guarantees every interest gets representation before
 * the strongest cluster takes a second slot.
 */
export function roundRobinByCluster(scored: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const byCluster = new Map<number, ScoredCandidate[]>();
  for (const c of scored) {
    if (!byCluster.has(c.clusterIndex)) byCluster.set(c.clusterIndex, []);
    byCluster.get(c.clusterIndex)!.push(c);
  }
  for (const arr of byCluster.values()) arr.sort((a, b) => b.score - a.score);

  const clusterIndices = Array.from(byCluster.keys()).sort((a, b) => a - b);
  const out: ScoredCandidate[] = [];
  let cursor = 0;
  while (out.length < limit && clusterIndices.length > 0) {
    const startCursor = cursor;
    let pickedThisLap = false;
    for (let i = 0; i < clusterIndices.length; i++) {
      const ci = clusterIndices[(startCursor + i) % clusterIndices.length]!;
      const queue = byCluster.get(ci)!;
      const next = queue.shift();
      if (next) {
        out.push(next);
        pickedThisLap = true;
        if (out.length >= limit) break;
      }
    }
    cursor++;
    if (!pickedThisLap) break;
  }
  return out;
}

// ---------- exploration ----------

type NoveltyPick = { item: ClothingItem; maxSim: number; clusterIndex: number };

async function fetchRandomItems(
  count: number,
  excludeIds: string[],
  filters: FeedFilters,
): Promise<ClothingItem[]> {
  if (count <= 0) return [];
  const filterClauses = buildItemFilterSql(excludeIds, filters);
  const filterSql = Prisma.join(filterClauses, " AND ");
  const idRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT ci.id
    FROM "ClothingItem" ci
    WHERE ${filterSql}
    ORDER BY RANDOM()
    LIMIT ${count}
  `;
  if (idRows.length === 0) return [];
  const ids = idRows.map((r) => r.id);
  const rows = await prisma.clothingItem.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((x): x is ClothingItem => x !== undefined);
}

/**
 * Novelty: random sample from the catalog, then JS-side keep items least
 * similar to the user's existing clusters (broadens taste without going fully
 * random). Returns up to `count` items, each annotated with its similarity to
 * the nearest cluster so the explainer can show a calibrated score.
 */
async function fetchNoveltyItems(
  count: number,
  excludeIds: string[],
  filters: FeedFilters,
  clusters: { centroid: Vector }[],
): Promise<NoveltyPick[]> {
  if (count <= 0 || clusters.length === 0) return [];
  const filterClauses = buildItemFilterSql(excludeIds, filters);
  const filterSql = Prisma.join(filterClauses, " AND ");
  const poolSize = count * 6;
  const rows = await prisma.$queryRaw<{ itemId: string; vector: string }[]>`
    SELECT ie."itemId" AS "itemId", ie.vector::text AS vector
    FROM "ItemEmbedding" ie
    JOIN "ClothingItem" ci ON ci.id = ie."itemId"
    WHERE ie.model = ${EMBEDDING_MODEL} AND ${filterSql}
    ORDER BY RANDOM()
    LIMIT ${poolSize}
  `;
  if (rows.length === 0) return [];

  // For each candidate, score = max(sim to any cluster). Keep lowest.
  const scored = rows.map((r) => {
    const v = normalize(parseVector(r.vector));
    let maxSim = -Infinity;
    let bestCluster = 0;
    for (let i = 0; i < clusters.length; i++) {
      const s = dot(v, clusters[i]!.centroid);
      if (s > maxSim) {
        maxSim = s;
        bestCluster = i;
      }
    }
    return { itemId: r.itemId, maxSim, clusterIndex: bestCluster };
  });
  scored.sort((a, b) => a.maxSim - b.maxSim);
  const picks = scored.slice(0, count);
  const ids = picks.map((s) => s.itemId);
  const items = await prisma.clothingItem.findMany({ where: { id: { in: ids } } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: NoveltyPick[] = [];
  for (const p of picks) {
    const item = byId.get(p.itemId);
    if (item) out.push({ item, maxSim: p.maxSim, clusterIndex: p.clusterIndex });
  }
  return out;
}

/**
 * Interleave exploration items into the personalized list. Exploration items
 * are spread roughly evenly so they don't all land at the end of the scroll.
 *
 * Generic in T so callers can mix ClothingItem[] (the original use) or
 * FeedEntry[] (when carrying per-card match metadata) through this function
 * without losing data.
 */
export function interleaveExploration<T>(
  personalized: T[],
  exploration: T[],
  rand: () => number,
): T[] {
  if (exploration.length === 0) return personalized;
  if (personalized.length === 0) return exploration;
  const total = personalized.length + exploration.length;
  const stride = total / exploration.length;

  const explorationSlots = new Set<number>();
  for (let e = 0; e < exploration.length; e++) {
    const target = Math.floor(stride * (e + 0.5) + (rand() - 0.5) * stride * 0.5);
    let slot = Math.max(0, Math.min(total - 1, target));
    while (explorationSlots.has(slot)) slot = (slot + 1) % total;
    explorationSlots.add(slot);
  }

  const out: T[] = [];
  let p = 0;
  let e = 0;
  for (let i = 0; i < total; i++) {
    if (explorationSlots.has(i) && e < exploration.length) {
      out.push(exploration[e]!);
      e++;
    } else if (p < personalized.length) {
      out.push(personalized[p]!);
      p++;
    } else if (e < exploration.length) {
      out.push(exploration[e]!);
      e++;
    }
  }
  return out;
}

// ---------- match builders ----------

function personalizedMatch(
  itemId: string,
  clusterIndex: number,
  clusterSim: number,
  topContributors: ClusterContributor[],
): FeedMatch {
  return {
    itemId,
    source: "personalized",
    clusterIndex,
    clusterSim,
    scorePct: calibrateScorePct(clusterSim),
    bucket: bucketForClusterSim(clusterSim),
    topContributors,
  };
}

function noveltyMatch(itemId: string, clusterIndex: number, maxSim: number): FeedMatch {
  const scorePct = calibrateScorePct(maxSim);
  return {
    itemId,
    source: "novelty",
    clusterIndex,
    clusterSim: maxSim,
    scorePct,
    bucket: bucketForScorePct(scorePct),
    topContributors: [],
  };
}

function randomMatch(itemId: string): FeedMatch {
  return {
    itemId,
    source: "random",
    clusterIndex: null,
    clusterSim: null,
    scorePct: null,
    bucket: null,
    topContributors: [],
  };
}

function coldStartMatch(itemId: string): FeedMatch {
  return {
    itemId,
    source: "cold_start",
    clusterIndex: null,
    clusterSim: null,
    scorePct: null,
    bucket: null,
    topContributors: [],
  };
}

// ---------- cold start ----------

async function coldStartFeed(
  user: { stylePreferences: string[]; favoriteBrands: string[] },
  excludeIds: string[],
  filters: FeedFilters,
  limit: number,
): Promise<FeedEntry[]> {
  // Apply tag-preference filter as a soft preference: get a larger random pool,
  // then prefer items that overlap with stylePreferences / favoriteBrands.
  const filterClauses = buildItemFilterSql(excludeIds, filters);
  const filterSql = Prisma.join(filterClauses, " AND ");
  const poolSize = Math.max(limit * 3, 60);

  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT ci.id
    FROM "ClothingItem" ci
    WHERE ${filterSql}
    ORDER BY RANDOM()
    LIMIT ${poolSize}
  `;
  if (ids.length === 0) return [];

  const items = await prisma.clothingItem.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
  });

  const styleSet = new Set(user.stylePreferences.map((s) => s.toLowerCase()));
  const brandSet = new Set(user.favoriteBrands.map((s) => s.toLowerCase()));
  const scored = items.map((item) => {
    let s = Math.random() * 0.05; // jitter
    if (brandSet.has(item.brand.toLowerCase())) s += 0.5;
    let styleMatches = 0;
    for (const t of item.tags) if (styleSet.has(t.toLowerCase())) styleMatches++;
    s += Math.min(styleMatches, STYLE_MATCH_CAP) * 0.2;
    return { item, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => ({
    item: x.item,
    match: coldStartMatch(x.item.id),
  }));
}

// ---------- top-level entry ----------

export type BuildFeedArgs = {
  userId: string;
  limit: number;
  filters: FeedFilters;
  /** Items already held/seen by this client session but not necessarily
   * persisted as Swipe rows yet. This closes the batch-flush race during
   * infinite scrolling. */
  excludeIds?: string[];
};

export async function buildPersonalizedFeed(args: BuildFeedArgs): Promise<FeedEntry[]> {
  const { userId, limit, filters } = args;

  // Excluded items: previously-swiped (cap 1000 most recent).
  const swiped = await prisma.swipe.findMany({
    where: { userId },
    select: { itemId: true },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const excludeIds = [
    ...new Set([
      ...(args.excludeIds ?? []).filter((id) => UUID_REGEX.test(id)),
      ...swiped.map((s) => s.itemId).filter((id) => UUID_REGEX.test(id)),
    ]),
  ];

  const [user, clusterState] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { stylePreferences: true, favoriteBrands: true, gender: true },
    }),
    getUserClusters(userId),
  ]);
  if (!user) return [];

  if (clusterState.clusters.length === 0) {
    return coldStartFeed(user, excludeIds, filters, limit);
  }

  // Slot budget for the three pools.
  const nPersonalized = Math.max(1, Math.floor(limit * PERSONALIZED_FRACTION));
  const nNovelty = Math.max(0, Math.floor(limit * NOVELTY_FRACTION));
  const nRandom = Math.max(0, limit - nPersonalized - nNovelty);

  // 1. Candidate retrieval per cluster.
  const candidates = await retrieveCandidatesPerCluster(clusterState.clusters, excludeIds, filters);
  if (candidates.length === 0) {
    return coldStartFeed(user, excludeIds, filters, limit);
  }

  // 2. Hydrate item rows + dislike distances for scoring.
  const candidateIds = candidates.map((c) => c.itemId);
  const [items, dislikeDist] = await Promise.all([
    prisma.clothingItem.findMany({ where: { id: { in: candidateIds } } }),
    clusterState.dislikeCentroid
      ? dislikeDistancesFor(candidateIds, clusterState.dislikeCentroid)
      : Promise.resolve(new Map<string, number>()),
  ]);
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // 3. Score, rank, diversify.
  const scored = scoreCandidates(candidates, itemsById, user, dislikeDist, Math.random);
  scored.sort((a, b) => b.score - a.score);
  const diversified = roundRobinByCluster(scored, nPersonalized);
  const personalized: FeedEntry[] = [];
  for (const c of diversified) {
    const item = itemsById.get(c.itemId);
    if (!item) continue;
    const cluster = clusterState.clusters[c.clusterIndex];
    const contributors = cluster?.topContributors ?? [];
    personalized.push({
      item,
      match: personalizedMatch(item.id, c.clusterIndex, c.clusterSim, contributors),
    });
  }

  // 4. Exploration: items not already in personalized set.
  const personalizedIds = new Set(personalized.map((e) => e.item.id));
  const expExclude = [...excludeIds, ...personalizedIds];
  const [noveltyPicks, randomItems] = await Promise.all([
    fetchNoveltyItems(nNovelty, expExclude, filters, clusterState.clusters),
    fetchRandomItems(nRandom, [...expExclude], filters),
  ]);

  const noveltyEntries: FeedEntry[] = noveltyPicks.map((p) => ({
    item: p.item,
    match: noveltyMatch(p.item.id, p.clusterIndex, p.maxSim),
  }));
  const randomEntries: FeedEntry[] = randomItems.map((item) => ({
    item,
    match: randomMatch(item.id),
  }));

  // 5. Interleave so exploration items appear throughout the scroll.
  const explorationPool: FeedEntry[] = [...noveltyEntries, ...randomEntries];
  // shuffle exploration pool so novelty and random mix
  for (let i = explorationPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [explorationPool[i], explorationPool[j]] = [explorationPool[j]!, explorationPool[i]!];
  }
  return interleaveExploration(personalized, explorationPool, Math.random);
}
