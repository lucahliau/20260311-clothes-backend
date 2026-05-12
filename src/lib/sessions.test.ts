import { describe, it, expect } from "vitest";
import {
  withinRotationGrace,
  isExpired,
  hashRefreshToken,
  generateRefreshTokenPair,
  nextExpiresAt,
  ROTATION_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
} from "./sessions.js";

describe("withinRotationGrace", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("returns false when there is no rotation timestamp yet", () => {
    expect(withinRotationGrace(null, now)).toBe(false);
  });

  it("returns true exactly at the grace boundary", () => {
    const rotatedAt = new Date(now.getTime() - ROTATION_GRACE_MS);
    expect(withinRotationGrace(rotatedAt, now)).toBe(true);
  });

  it("returns false one ms past the grace boundary", () => {
    const rotatedAt = new Date(now.getTime() - ROTATION_GRACE_MS - 1);
    expect(withinRotationGrace(rotatedAt, now)).toBe(false);
  });

  it("returns true for a rotation that just happened", () => {
    expect(withinRotationGrace(new Date(now.getTime() - 1), now)).toBe(true);
  });
});

describe("isExpired", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("treats a deadline exactly at now as expired (conservative)", () => {
    expect(isExpired(now, now)).toBe(true);
  });

  it("returns true for deadlines in the past", () => {
    expect(isExpired(new Date(now.getTime() - 1), now)).toBe(true);
  });

  it("returns false for deadlines in the future", () => {
    expect(isExpired(new Date(now.getTime() + 1000), now)).toBe(false);
  });
});

describe("hashRefreshToken", () => {
  it("is deterministic for the same input", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
  });

  it("yields different hashes for different inputs", () => {
    expect(hashRefreshToken("abc")).not.toBe(hashRefreshToken("abd"));
  });

  it("produces a 64-char hex string (sha256)", () => {
    expect(hashRefreshToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateRefreshTokenPair", () => {
  it("returns a raw token whose hash matches hashRefreshToken(raw)", () => {
    const { raw, hash } = generateRefreshTokenPair();
    expect(hash).toBe(hashRefreshToken(raw));
  });

  it("returns a different token every call", () => {
    const a = generateRefreshTokenPair();
    const b = generateRefreshTokenPair();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("nextExpiresAt", () => {
  it("sets the deadline 30 days out from `now`", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    expect(nextExpiresAt(now).getTime() - now.getTime()).toBe(REFRESH_TOKEN_TTL_MS);
  });
});
