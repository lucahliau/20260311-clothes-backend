import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, seedItems, type TestUser } from "./helpers.js";
import { prisma } from "../../src/lib/prisma.js";

describe("items catalog", () => {
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    await seedItems(25);
  });

  it("lists items with pagination metadata", async () => {
    const res = await request(app()).get("/items");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(25);
    expect(res.body.pagination).toMatchObject({ page: 1, total: 25, totalPages: 1 });
  });

  it("pages with limit/page and computes totalPages from the effective limit", async () => {
    const res = await request(app()).get("/items?limit=10&page=2");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 10, total: 25, totalPages: 3 });
  });

  it("clamps absurd limits to the server-side maximum (200)", async () => {
    const res = await request(app()).get("/items?limit=999999");
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(200);
  });

  it("filters by brand and search term", async () => {
    await seedItems(3, { brand: "OtherBrand" });

    const byBrand = await request(app()).get("/items?brand=OtherBrand");
    expect(byBrand.body.pagination.total).toBe(3);

    const bySearch = await request(app()).get("/items?search=otherbrand");
    expect(bySearch.body.pagination.total).toBe(3);
  });

  it("serves an identical contract under /v1", async () => {
    const [bare, v1] = await Promise.all([
      request(app()).get("/items?limit=5&brand=TestBrand"),
      request(app()).get("/v1/items?limit=5&brand=TestBrand"),
    ]);
    expect(bare.status).toBe(200);
    expect(v1.status).toBe(200);
    expect(v1.body.pagination).toEqual(bare.body.pagination);
    const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id).sort();
    expect(ids(v1)).toEqual(ids(bare));
  });

  it("serves the personalized feed (fallback path) to authed users only", async () => {
    expect((await request(app()).get("/items/feed")).status).toBe(401);

    const res = await request(app()).get("/items/feed?limit=10").set(auth(user.accessToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeLessThanOrEqual(10);
  });

  it("continues a feed without repeating client-seen items", async () => {
    const eligible = await seedItems(4, { brand: "ContinuationBrand" });
    await Promise.all(
      eligible.map((item) =>
        prisma.clothingItem.update({ where: { id: item.id }, data: { hasNobg: true } }),
      ),
    );

    const excludedIds = eligible.slice(0, 2).map((item) => item.id);
    const res = await request(app())
      .post("/items/feed?limit=10")
      .set(auth(user.accessToken))
      .send({ excludeIds: excludedIds });

    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.items.map((item: { id: string }) => item.id)).not.toEqual(
      expect.arrayContaining(excludedIds),
    );
  });
});

describe("items stock filter and price sort", () => {
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    await seedItems(1, { brand: "SortBrand", price: 80 });
    await seedItems(1, { brand: "SortBrand", price: 120, salePrice: 30 });
    await seedItems(1, { brand: "SortBrand", price: 50, inStock: true });
    await seedItems(1, { brand: "SortBrand", price: 10, inStock: false });
  });

  it("hides out-of-stock items by default and returns them on opt-in", async () => {
    const hidden = await request(app()).get("/items?brand=SortBrand");
    expect(hidden.body.pagination.total).toBe(3);
    expect(hidden.body.items.every((i: { inStock: boolean | null }) => i.inStock !== false)).toBe(
      true,
    );

    const all = await request(app()).get("/items?brand=SortBrand&includeOutOfStock=true");
    expect(all.body.pagination.total).toBe(4);

    const search = await request(app()).get("/items?search=sortbrand");
    expect(search.body.pagination.total).toBe(3);
  });

  it("sorts by effective price in both directions", async () => {
    const prices = (r: { body: { items: { price: string; salePrice: string | null }[] } }) =>
      r.body.items.map((i) => Number(i.salePrice ?? i.price));

    const asc = await request(app()).get("/items?brand=SortBrand&sort=price_asc");
    expect(asc.status).toBe(200);
    expect(prices(asc)).toEqual([30, 50, 80]);
    expect(asc.body.pagination).toMatchObject({ page: 1, total: 3, totalPages: 1 });

    const desc = await request(app()).get(
      "/items?brand=SortBrand&sort=price_desc&includeOutOfStock=true",
    );
    expect(prices(desc)).toEqual([80, 50, 30, 10]);

    const page2 = await request(app()).get("/items?brand=SortBrand&sort=price_asc&limit=2&page=2");
    expect(prices(page2)).toEqual([80]);
  });

  it("still serves an out-of-stock item by id and in swipe history", async () => {
    const soldOut = await prisma.clothingItem.findFirstOrThrow({ where: { inStock: false } });
    const byId = await request(app()).get(`/items/${soldOut.id}`);
    expect(byId.status).toBe(200);

    await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: soldOut.id, action: "LOVE" });
    const history = await request(app())
      .get("/swipes/history?action=LOVE,LIKE")
      .set(auth(user.accessToken));
    expect(history.body.swipes.map((s: { itemId: string }) => s.itemId)).toContain(soldOut.id);
    expect(history.body.pagination).toMatchObject({ page: 1, total: 1, totalPages: 1 });
  });
});
