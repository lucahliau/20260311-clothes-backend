/**
 * Spherical (cosine) k-means with per-point weights.
 *
 * Vectors are expected to be L2-normalized — call `normalize()` before
 * `sphericalKMeans()` when in doubt. Centroids are re-normalized after every
 * iteration, so cosine similarity collapses to a dot product everywhere
 * downstream.
 */

export type Vector = Float32Array;

export function normalize(v: Vector): Vector {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export interface SphericalKMeansResult {
  centroids: Vector[]; // L2-normalized
  assignments: number[]; // length = points.length, value in [0, K)
  weights: number[]; // summed point weight per cluster
}

export interface SphericalKMeansOptions {
  maxIters?: number;
  seed?: number;
}

// Deterministic LCG so tests are reproducible without pulling a PRNG dep.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * k-means++ seeding adapted for cosine similarity: the probability of picking
 * a point as the next center is proportional to `(1 - max_sim)^2 * weight`,
 * which spreads initial centers across modes instead of clumping.
 */
function kmeansPlusPlusInit(
  points: Vector[],
  weights: number[],
  k: number,
  rand: () => number,
): Vector[] {
  const n = points.length;
  const first = Math.floor(rand() * n);
  const centers: Vector[] = [points[first]!];

  const maxSim = new Float64Array(n);
  for (let i = 0; i < n; i++) maxSim[i] = dot(points[i]!, points[first]!);

  while (centers.length < k) {
    let total = 0;
    const probs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = 1 - maxSim[i]!;
      const p = d * d * (weights[i] ?? 1);
      probs[i] = p;
      total += p;
    }
    if (total <= 0) break;
    let r = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= probs[i]!;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    const c = points[pick]!;
    centers.push(c);
    for (let i = 0; i < n; i++) {
      const s = dot(points[i]!, c);
      if (s > maxSim[i]!) maxSim[i] = s;
    }
  }

  return centers;
}

export function sphericalKMeans(
  points: Vector[],
  k: number,
  weights?: number[],
  opts: SphericalKMeansOptions = {},
): SphericalKMeansResult {
  const n = points.length;
  if (n === 0) return { centroids: [], assignments: [], weights: [] };
  const dim = points[0]!.length;
  const w = weights ?? new Array(n).fill(1);
  const effectiveK = Math.max(1, Math.min(k, n));
  const maxIters = opts.maxIters ?? 25;
  const rand = lcg(opts.seed ?? 1);

  const centroids = kmeansPlusPlusInit(points, w, effectiveK, rand);
  // Pad if init returned fewer than k (n < k or degenerate weights).
  while (centroids.length < effectiveK) {
    centroids.push(points[Math.floor(rand() * n)]!);
  }

  const assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    // Assignment step: pick centroid with max cosine similarity.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const s = dot(points[i]!, centroids[c]!);
        if (s > bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    // Update step: weighted mean, then renormalize.
    const sums: Float32Array[] = Array.from({ length: effectiveK }, () => new Float32Array(dim));
    const counts = new Float64Array(effectiveK);
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      const wi = w[i] ?? 1;
      counts[c] = counts[c]! + wi;
      const sum = sums[c]!;
      const p = points[i]!;
      for (let d = 0; d < dim; d++) sum[d] = sum[d]! + p[d]! * wi;
    }
    for (let c = 0; c < effectiveK; c++) {
      if (counts[c] === 0) continue; // empty cluster: keep old centroid
      centroids[c] = normalize(sums[c]!);
    }

    if (!changed && iter > 0) break;
  }

  const clusterWeights = new Array<number>(effectiveK).fill(0);
  for (let i = 0; i < n; i++) {
    clusterWeights[assignments[i]!] = (clusterWeights[assignments[i]!] ?? 0) + (w[i] ?? 1);
  }

  return { centroids, assignments, weights: clusterWeights };
}

/** Adaptive K used by feed personalization: 10 likes → 2, ~36 → 3, ~100 → 5. */
export function pickK(n: number): number {
  if (n < 5) return 1;
  return Math.max(2, Math.min(5, Math.round(Math.sqrt(n / 4))));
}
