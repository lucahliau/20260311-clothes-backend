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
