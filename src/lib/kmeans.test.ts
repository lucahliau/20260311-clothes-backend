import { describe, it, expect } from "vitest";
import { sphericalKMeans, normalize, pickK, type Vector } from "./kmeans.js";

function v(arr: number[]): Vector {
  return normalize(new Float32Array(arr));
}

describe("pickK", () => {
  it("returns 1 for too-few points (cold-start gate)", () => {
    expect(pickK(0)).toBe(1);
    expect(pickK(4)).toBe(1);
  });
  it("clamps to [2,5]", () => {
    expect(pickK(5)).toBe(2);
    expect(pickK(36)).toBe(3);
    expect(pickK(100)).toBe(5);
    expect(pickK(1000)).toBe(5);
  });
});

describe("sphericalKMeans", () => {
  it("separates two well-defined clusters in 4D", () => {
    // Cluster A: vectors near [1,0,0,0]; Cluster B: vectors near [0,1,0,0].
    const aPts = Array.from({ length: 8 }, (_, i) => v([1, 0.05 * i, 0, 0]));
    const bPts = Array.from({ length: 8 }, (_, i) => v([0, 1, 0.05 * i, 0]));
    const points = [...aPts, ...bPts];

    const { centroids, assignments } = sphericalKMeans(points, 2, undefined, { seed: 42 });
    expect(centroids).toHaveLength(2);

    // All A points should share one assignment, all B points the other.
    const aAssign = new Set(assignments.slice(0, 8));
    const bAssign = new Set(assignments.slice(8));
    expect(aAssign.size).toBe(1);
    expect(bAssign.size).toBe(1);
    expect([...aAssign][0]).not.toBe([...bAssign][0]);
  });

  it("honors per-point weights when forming centroids", () => {
    // Two clusters but cluster B has dominant weights — centroid weights reflect.
    const aPts = Array.from({ length: 5 }, () => v([1, 0, 0]));
    const bPts = Array.from({ length: 5 }, () => v([0, 1, 0]));
    const weights = [1, 1, 1, 1, 1, 5, 5, 5, 5, 5];
    const { weights: clusterWeights } = sphericalKMeans(
      [...aPts, ...bPts],
      2,
      weights,
      { seed: 1 },
    );
    const max = Math.max(...clusterWeights);
    const min = Math.min(...clusterWeights);
    expect(max).toBeGreaterThan(min);
    expect(max).toBeGreaterThanOrEqual(25);
  });

  it("returns empty result for zero points", () => {
    const res = sphericalKMeans([], 3);
    expect(res.centroids).toHaveLength(0);
    expect(res.assignments).toHaveLength(0);
  });
});
