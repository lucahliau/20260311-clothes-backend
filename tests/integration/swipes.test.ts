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

  it("creates a swipe, upserts duplicates idempotently, and 404s unknown items", async () => {
    const created = await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: itemIds[0], action: "LOVE" });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe("LOVE");

    // Re-swiping the same item must not 409 (the app would re-present the
    // card forever) — it updates the stored action in place.
    const dupe = await request(app())
      .post("/swipes")
      .set(auth(user.accessToken))
      .send({ itemId: itemIds[0], action: "LIKE" });
    expect(dupe.status).toBe(201);
    expect(dupe.body.action).toBe("LIKE");
    expect(dupe.body.id).toBe(created.body.id);

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

describe("swipes batch", () => {
  let user: TestUser;
  let ids: string[];

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    ids = (await seedItems(4)).map((i) => i.id);
  });

  it("records many swipes in one request, skipping unknown items", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const res = await request(app())
      .post("/swipes/batch")
      .set(auth(user.accessToken))
      .send({
        swipes: [
          { itemId: ids[0], action: "LOVE" },
          { itemId: ids[1], action: "DISLIKE" },
          { itemId: ids[2], action: "LIKE" },
          { itemId: unknown, action: "LIKE" }, // not in catalog → skipped, not 404
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 3, skipped: 1 });

    const history = await request(app()).get("/swipes/history").set(auth(user.accessToken));
    expect(history.body.pagination.total).toBe(3);
  });

  it("re-sending updates actions in place — last action wins, no duplicate rows", async () => {
    const res = await request(app())
      .post("/swipes/batch")
      .set(auth(user.accessToken))
      .send({
        swipes: [
          { itemId: ids[0], action: "DISLIKE" }, // was LOVE
          { itemId: ids[3], action: "LIKE" }, // new
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 2, skipped: 0 });

    const history = await request(app()).get("/swipes/history").set(auth(user.accessToken));
    expect(history.body.pagination.total).toBe(4); // ids[0] updated, ids[3] added — no dupes
    const byItem = new Map<string, string>(
      history.body.swipes.map((s: { item: { id: string }; action: string }) => [
        s.item.id,
        s.action,
      ]),
    );
    expect(byItem.get(ids[0])).toBe("DISLIKE");
    expect(byItem.get(ids[3])).toBe("LIKE");
  });

  it("dedupes repeated items within one batch (last action wins)", async () => {
    const fresh = await createVerifiedUser();
    const res = await request(app())
      .post("/swipes/batch")
      .set(auth(fresh.accessToken))
      .send({
        swipes: [
          { itemId: ids[1], action: "LOVE" },
          { itemId: ids[1], action: "NEUTRAL" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1, skipped: 0 });

    const history = await request(app()).get("/swipes/history").set(auth(fresh.accessToken));
    expect(history.body.pagination.total).toBe(1);
    expect(history.body.swipes[0].action).toBe("NEUTRAL");
  });
});
