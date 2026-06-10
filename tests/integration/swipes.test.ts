import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, seedItems, type TestUser } from "./helpers.js";

describe("swipes", () => {
  let user: TestUser;
  let itemIds: string[];

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    itemIds = (await seedItems(5)).map((i) => i.id);
  });

  it("creates a swipe, rejects duplicates with 409, and 404s unknown items", async () => {
    const created = await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: itemIds[0], action: "LOVE" });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe("LOVE");

    const dupe = await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: itemIds[0], action: "LIKE" });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe("CONFLICT");

    const ghost = await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: "00000000-0000-4000-8000-000000000000", action: "LIKE" });
    expect(ghost.status).toBe(404);
  });

  it("updates a swipe's action and paginates history", async () => {
    for (const id of itemIds.slice(1, 4)) {
      const res = await request(app())
        .post("/swipes")
        .set(auth(user.accessToken))
        .send({ itemId: id, action: "LIKE" });
      expect(res.status).toBe(201);
    }

    const history = await request(app()).get("/swipes/history?limit=2").set(auth(user.accessToken));
    expect(history.status).toBe(200);
    expect(history.body.swipes).toHaveLength(2);
    expect(history.body.pagination).toMatchObject({ limit: 2, total: 4, totalPages: 2 });

    const target = history.body.swipes[0];
    const patched = await request(app())
      .patch(`/swipes/${target.id}`)
      .set(auth(user.accessToken))
      .send({ action: "DISLIKE" });
    expect(patched.status).toBe(200);
    expect(patched.body.action).toBe("DISLIKE");

    const filtered = await request(app())
      .get("/swipes/history?action=DISLIKE")
      .set(auth(user.accessToken));
    expect(filtered.body.pagination.total).toBe(1);
  });

  it("undoes the most recent swipe", async () => {
    const before = await request(app()).get("/swipes/history").set(auth(user.accessToken));
    const total = before.body.pagination.total as number;

    const undo = await request(app()).delete("/swipes/last").set(auth(user.accessToken));
    expect(undo.status).toBe(200);
    expect(undo.body.undone?.id).toBeTruthy();

    const after = await request(app()).get("/swipes/history").set(auth(user.accessToken));
    expect(after.body.pagination.total).toBe(total - 1);
  });
});
