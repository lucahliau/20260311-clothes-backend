import { describe, it, expect } from "vitest";
import { blockedUserIdsFromRows, type UserBlockRow } from "./social.js";

const ME = "user-me";
const A = "user-a";
const B = "user-b";
const C = "user-c";

describe("blockedUserIdsFromRows", () => {
  it("returns empty set when there are no rows", () => {
    expect(blockedUserIdsFromRows(ME, [])).toEqual(new Set());
  });

  it("includes users I have blocked", () => {
    const rows: UserBlockRow[] = [
      { blockerId: ME, blockedId: A },
      { blockerId: ME, blockedId: B },
    ];
    expect(blockedUserIdsFromRows(ME, rows)).toEqual(new Set([A, B]));
  });

  it("includes users who have blocked me", () => {
    const rows: UserBlockRow[] = [
      { blockerId: A, blockedId: ME },
      { blockerId: B, blockedId: ME },
    ];
    expect(blockedUserIdsFromRows(ME, rows)).toEqual(new Set([A, B]));
  });

  it("returns the union of both directions and deduplicates", () => {
    const rows: UserBlockRow[] = [
      { blockerId: ME, blockedId: A },
      { blockerId: A, blockedId: ME }, // duplicate direction for same pair
      { blockerId: ME, blockedId: B },
      { blockerId: C, blockedId: ME },
    ];
    expect(blockedUserIdsFromRows(ME, rows)).toEqual(new Set([A, B, C]));
  });

  it("never includes the viewer themselves, even if a row references them", () => {
    // Defensive: a malformed self-block row should never leak `me` into the set.
    const rows: UserBlockRow[] = [
      { blockerId: ME, blockedId: ME },
      { blockerId: ME, blockedId: A },
    ];
    const result = blockedUserIdsFromRows(ME, rows);
    expect(result.has(ME)).toBe(false);
    expect(result.has(A)).toBe(true);
  });
});
