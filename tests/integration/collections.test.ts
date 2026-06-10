import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, seedItems, type TestUser } from "./helpers.js";

describe("collections", () => {
  let user: TestUser;
  let itemIds: string[];
  let collectionId: string;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
    itemIds = (await seedItems(3)).map((i) => i.id);
  });

  it("creates, lists, and renames a collection", async () => {
    const created = await request(app())
      .post("/collections")
      .set(auth(user.accessToken))
      .send({ name: "Fits" });
    expect(created.status).toBe(201);
    collectionId = created.body.id;

    const list = await request(app()).get("/collections").set(auth(user.accessToken));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]._count.items).toBe(0);

    const renamed = await request(app())
      .patch(`/collections/${collectionId}`)
      .set(auth(user.accessToken))
      .send({ name: "Summer fits" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Summer fits");

    const emptyPatch = await request(app())
      .patch(`/collections/${collectionId}`)
      .set(auth(user.accessToken))
      .send({});
    expect(emptyPatch.status).toBe(400);
  });

  it("adds and removes items, rejecting duplicates", async () => {
    for (const id of itemIds.slice(0, 2)) {
      const added = await request(app())
        .post(`/collections/${collectionId}/items`)
        .set(auth(user.accessToken))
        .send({ itemId: id });
      expect(added.status).toBe(201);
    }

    const dupe = await request(app())
      .post(`/collections/${collectionId}/items`)
      .set(auth(user.accessToken))
      .send({ itemId: itemIds[0] });
    expect(dupe.status).toBe(409);

    const detail = await request(app())
      .get(`/collections/${collectionId}`)
      .set(auth(user.accessToken));
    expect(detail.status).toBe(200);
    expect(detail.body.items).toHaveLength(2);
    expect(detail.body.items[0].item.id).toBeTruthy();

    const removed = await request(app())
      .delete(`/collections/${collectionId}/items/${itemIds[0]}`)
      .set(auth(user.accessToken));
    expect(removed.status).toBe(200);

    const afterRemove = await request(app())
      .get(`/collections/${collectionId}`)
      .set(auth(user.accessToken));
    expect(afterRemove.body.items).toHaveLength(1);
  });

  it("deletes the collection", async () => {
    const del = await request(app())
      .delete(`/collections/${collectionId}`)
      .set(auth(user.accessToken));
    expect(del.status).toBe(200);

    const gone = await request(app())
      .get(`/collections/${collectionId}`)
      .set(auth(user.accessToken));
    expect(gone.status).toBe(404);
  });
});
