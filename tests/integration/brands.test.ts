import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, seedItems, type TestUser } from "./helpers.js";

describe("brand favorites", () => {
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    await seedItems(3, { brand: "Norse Projects" });
  });

  it("requires auth", async () => {
    const res = await request(app()).get("/brands/favorites");
    expect(res.status).toBe(401);
  });

  it("saves, lists with product counts, and unsaves a brand", async () => {
    const empty = await request(app()).get("/brands/favorites").set(auth(user.accessToken));
    expect(empty.status).toBe(200);
    expect(empty.body.brands).toEqual([]);

    const save = await request(app())
      .put("/brands/favorites")
      .set(auth(user.accessToken))
      .send({ brand: "Norse Projects", favorite: true });
    expect(save.status).toBe(200);
    expect(save.body.favoriteBrands).toEqual(["Norse Projects"]);

    // Idempotent: saving again (different case) doesn't duplicate.
    const again = await request(app())
      .put("/brands/favorites")
      .set(auth(user.accessToken))
      .send({ brand: "norse projects", favorite: true });
    expect(again.body.favoriteBrands).toHaveLength(1);

    const list = await request(app()).get("/brands/favorites").set(auth(user.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.brands).toEqual([{ brand: "norse projects", productCount: 3 }]);

    const unsave = await request(app())
      .put("/brands/favorites")
      .set(auth(user.accessToken))
      .send({ brand: "Norse Projects", favorite: false });
    expect(unsave.status).toBe(200);
    expect(unsave.body.favoriteBrands).toEqual([]);
  });

  it("rejects invalid payloads with 400", async () => {
    const res = await request(app())
      .put("/brands/favorites")
      .set(auth(user.accessToken))
      .send({ brand: "", favorite: true });
    expect(res.status).toBe(400);
  });
});

describe("brand listing", () => {
  beforeAll(async () => {
    await resetDb();
    await seedItems(3, { brand: "Big Brand" });
    await seedItems(2, { brand: "Big Brand", inStock: false });
    await seedItems(1, { brand: "Tiny Brand" });
    await seedItems(2, { brand: "Sold Out Brand", inStock: false });
  });

  it("counts only in-stock (or unknown-stock) items and drops fully sold-out brands", async () => {
    const res = await request(app()).get("/brands?limit=1000");
    expect(res.status).toBe(200);
    expect(res.body.brands).toEqual([
      { brand: "Big Brand", productCount: 3 },
      { brand: "Tiny Brand", productCount: 1 },
    ]);
  });

  it("filters small brands with minProducts", async () => {
    const res = await request(app()).get("/brands?minProducts=2");
    expect(res.body.brands).toEqual([{ brand: "Big Brand", productCount: 3 }]);

    const ignored = await request(app()).get("/brands?minProducts=abc");
    expect(ignored.body.brands).toHaveLength(2);
  });
});
