import { describe, it, expect } from "vitest";
import { resolveRequestId } from "./requestId.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveRequestId", () => {
  it("generates a UUID v4 when no header is provided", () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(UUID_RE);
  });

  it("generates fresh UUIDs each call when no header is provided", () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });

  it("honors a valid inbound UUID header", () => {
    const given = "550e8400-e29b-41d4-a716-446655440000";
    expect(resolveRequestId(given)).toBe(given);
  });

  it("rejects a non-UUID header and falls back to a fresh UUID", () => {
    expect(resolveRequestId("not-a-uuid")).toMatch(UUID_RE);
    expect(resolveRequestId("not-a-uuid")).not.toBe("not-a-uuid");
  });

  it("rejects header strings that contain a UUID plus extra junk (no partial matches)", () => {
    expect(resolveRequestId("550e8400-e29b-41d4-a716-446655440000; evil"))
      .toMatch(UUID_RE);
  });

  it("rejects non-string header values (array, number, null)", () => {
    expect(resolveRequestId(["550e8400-e29b-41d4-a716-446655440000"])).toMatch(UUID_RE);
    expect(resolveRequestId(42)).toMatch(UUID_RE);
    expect(resolveRequestId(null)).toMatch(UUID_RE);
  });
});
