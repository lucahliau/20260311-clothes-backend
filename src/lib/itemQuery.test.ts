import { describe, it, expect } from "vitest";
import { itemOrderBySql, parseBooleanFlag, parseItemSort, parseMinProducts } from "./itemQuery.js";

describe("parseItemSort", () => {
  it("accepts the three known sorts, case-insensitively", () => {
    expect(parseItemSort("newest")).toBe("newest");
    expect(parseItemSort("price_asc")).toBe("price_asc");
    expect(parseItemSort(" PRICE_DESC ")).toBe("price_desc");
  });

  it("falls back to newest for absent or unknown values", () => {
    expect(parseItemSort(undefined)).toBe("newest");
    expect(parseItemSort("cheapest")).toBe("newest");
    expect(parseItemSort(["price_asc"])).toBe("newest");
  });
});

describe("itemOrderBySql", () => {
  it("sorts by effective price with nulls last and an id tiebreaker", () => {
    expect(itemOrderBySql("price_asc").sql).toBe(
      'COALESCE("salePrice", price) ASC NULLS LAST, id ASC',
    );
    expect(itemOrderBySql("price_desc").sql).toBe(
      'COALESCE("salePrice", price) DESC NULLS LAST, id ASC',
    );
  });

  it("keeps newest-first as the default order", () => {
    expect(itemOrderBySql("newest").sql).toBe('"createdAt" DESC, id ASC');
  });
});

describe("parseBooleanFlag", () => {
  it("is on only for true/1", () => {
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("TRUE")).toBe(true);
    expect(parseBooleanFlag("1")).toBe(true);
    expect(parseBooleanFlag("false")).toBe(false);
    expect(parseBooleanFlag("")).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
  });
});

describe("parseMinProducts", () => {
  it("returns a positive integer threshold", () => {
    expect(parseMinProducts("10")).toBe(10);
    expect(parseMinProducts(" 50 ")).toBe(50);
  });

  it("ignores values that would not filter anything or are not integers", () => {
    expect(parseMinProducts(undefined)).toBeNull();
    expect(parseMinProducts("0")).toBeNull();
    expect(parseMinProducts("1")).toBeNull();
    expect(parseMinProducts("-5")).toBeNull();
    expect(parseMinProducts("2.5")).toBeNull();
    expect(parseMinProducts("abc")).toBeNull();
  });
});
