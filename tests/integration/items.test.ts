import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, seedItems, type TestUser } from "./helpers.js";

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

  it("clamps absurd limits to the server-side maximum (10k)", async () => {
    const res = await request(app()).get("/items?limit=999999");
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(10_000);
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
});
