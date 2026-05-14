import { describe, it, expect } from "vitest";
import {
  scoreCandidates,
  roundRobinByCluster,
  interleaveExploration,
  calibrateScorePct,
  bucketForClusterSim,
} from "./feed-personalization.js";
import type { ClothingItem } from "../../generated/prisma/client.js";

function fakeItem(id: string, overrides: Partial<ClothingItem> = {}): ClothingItem {
  return {
    id,
    name: "n",
    description: null,
    brand: "BrandX",
    category: "tops",
    subcategory: null,
    price: 0 as unknown as ClothingItem["price"],
    currency: "USD",
    imageUrl: "",
    images: [],
    colors: [],
    sizes: [],
    tags: [],
    gender: null,
    productType: null,
    sourceUrl: null,
    metadata: null,
    retailer: null,
    externalId: null,
    manufacturerCode: null,
    lastVerifiedAt: null,
    active: true,
    hasNobg: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const zeroRand = () => 0; // remove jitter for deterministic comparisons

describe("scoreCandidates", () => {
  it("higher cluster similarity yields higher score (monotonic in clusterSim)", () => {
    const items = new Map<string, ClothingItem>([
      ["a", fakeItem("a")],
      ["b", fakeItem("b")],
    ]);
    const scored = scoreCandidates(
      [
        { itemId: "a", clusterIndex: 0, clusterSim: 0.9 },
        { itemId: "b", clusterIndex: 0, clusterSim: 0.3 },
      ],
      items,
      { stylePreferences: [], favoriteBrands: [] },
      new Map(),
      zeroRand,
    );
    const a = scored.find((s) => s.itemId === "a")!;
    const b = scored.find((s) => s.itemId === "b")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("applies brand and style boosts; dislike-similarity penalizes", () => {
    const items = new Map<string, ClothingItem>([
      ["plain", fakeItem("plain", { brand: "Other", tags: [] })],
      ["match", fakeItem("match", { brand: "Nike", tags: ["minimalist", "vintage"] })],
      ["disliked", fakeItem("disliked", { brand: "Other", tags: [] })],
    ]);
    // Dislike distance close to 0 → item is very similar to disliked centroid.
    const dislikeDist = new Map([["disliked", 0.0]]);
    const scored = scoreCandidates(
      [
        { itemId: "plain", clusterIndex: 0, clusterSim: 0.5 },
        { itemId: "match", clusterIndex: 0, clusterSim: 0.5 },
        { itemId: "disliked", clusterIndex: 0, clusterSim: 0.5 },
      ],
      items,
      { stylePreferences: ["minimalist", "vintage"], favoriteBrands: ["nike"] },
      dislikeDist,
      zeroRand,
    );
    const byId = new Map(scored.map((s) => [s.itemId, s.score]));
    expect(byId.get("match")!).toBeGreaterThan(byId.get("plain")!);
    expect(byId.get("disliked")!).toBeLessThan(byId.get("plain")!);
  });
});

describe("roundRobinByCluster", () => {
  it("alternates between clusters before exhausting any one", () => {
    const cands = [
      { itemId: "a1", clusterIndex: 0, clusterSim: 0, score: 10 },
      { itemId: "a2", clusterIndex: 0, clusterSim: 0, score: 9 },
      { itemId: "a3", clusterIndex: 0, clusterSim: 0, score: 8 },
      { itemId: "b1", clusterIndex: 1, clusterSim: 0, score: 7 },
      { itemId: "b2", clusterIndex: 1, clusterSim: 0, score: 6 },
    ];
    const out = roundRobinByCluster(cands, 4);
    // First two slots must hit both clusters once each.
    const clusters = out
      .slice(0, 2)
      .map((c) => c.clusterIndex)
      .sort();
    expect(clusters).toEqual([0, 1]);
    // No cluster monopolizes the result.
    const counts = new Map<number, number>();
    for (const c of out) counts.set(c.clusterIndex, (counts.get(c.clusterIndex) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
    expect(out).toHaveLength(4);
  });

  it("respects limit and falls back when a cluster runs out", () => {
    const cands = [
      { itemId: "a1", clusterIndex: 0, clusterSim: 0, score: 10 },
      { itemId: "b1", clusterIndex: 1, clusterSim: 0, score: 9 },
      { itemId: "b2", clusterIndex: 1, clusterSim: 0, score: 8 },
      { itemId: "b3", clusterIndex: 1, clusterSim: 0, score: 7 },
    ];
    const out = roundRobinByCluster(cands, 10);
    expect(out).toHaveLength(4);
  });
});

describe("interleaveExploration", () => {
  it("spreads exploration items roughly evenly across the output", () => {
    const personalized = Array.from({ length: 7 }, (_, i) => fakeItem(`p${i}`));
    const exploration = Array.from({ length: 3 }, (_, i) => fakeItem(`e${i}`));
    const merged = interleaveExploration(personalized, exploration, () => 0.5);
    expect(merged).toHaveLength(10);
    const explorationIndices = merged
      .map((it, i) => (it.id.startsWith("e") ? i : -1))
      .filter((i) => i >= 0);
    expect(explorationIndices).toHaveLength(3);
    // Should not all bunch at the very end.
    expect(Math.min(...explorationIndices)).toBeLessThan(5);
  });

  it("returns inputs untouched at edges", () => {
    const a = [fakeItem("a")];
    expect(interleaveExploration(a, [], () => 0)).toEqual(a);
    expect(interleaveExploration([], a, () => 0)).toEqual(a);
  });

  it("preserves match metadata when mixing FeedEntry-shaped values", () => {
    type Entry = { item: ClothingItem; tag: string };
    const personalized: Entry[] = [
      { item: fakeItem("p0"), tag: "personalized" },
      { item: fakeItem("p1"), tag: "personalized" },
    ];
    const exploration: Entry[] = [
      { item: fakeItem("e0"), tag: "novelty" },
      { item: fakeItem("e1"), tag: "random" },
    ];
    const merged = interleaveExploration(personalized, exploration, () => 0.5);
    expect(merged).toHaveLength(4);
    const tagsByItem = new Map(merged.map((e) => [e.item.id, e.tag]));
    expect(tagsByItem.get("p0")).toBe("personalized");
    expect(tagsByItem.get("e0")).toBe("novelty");
    expect(tagsByItem.get("e1")).toBe("random");
  });
});

describe("calibrateScorePct", () => {
  it("is monotonic in cluster similarity", () => {
    const xs = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const ys = xs.map(calibrateScorePct);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
    }
  });

  it("clamps to [5, 99] and hits expected anchor points", () => {
    expect(calibrateScorePct(-0.5)).toBe(5);
    expect(calibrateScorePct(0.0)).toBe(5);
    expect(calibrateScorePct(0.15)).toBe(5);
    expect(calibrateScorePct(0.25)).toBeGreaterThanOrEqual(30);
    expect(calibrateScorePct(0.25)).toBeLessThanOrEqual(36);
    expect(calibrateScorePct(0.35)).toBeGreaterThanOrEqual(63);
    expect(calibrateScorePct(0.35)).toBeLessThanOrEqual(70);
    expect(calibrateScorePct(0.45)).toBe(99);
    expect(calibrateScorePct(0.9)).toBe(99);
  });
});

describe("bucketForClusterSim", () => {
  it("uses the documented thresholds", () => {
    expect(bucketForClusterSim(0.4)).toBe("high");
    expect(bucketForClusterSim(0.35)).toBe("high");
    expect(bucketForClusterSim(0.349)).toBe("medium");
    expect(bucketForClusterSim(0.25)).toBe("medium");
    expect(bucketForClusterSim(0.249)).toBe("low");
    expect(bucketForClusterSim(0.0)).toBe("low");
  });
});
