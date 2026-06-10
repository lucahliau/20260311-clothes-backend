import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import {
  app,
  auth,
  createVerifiedUser,
  makeFriends,
  resetDb,
  seedItems,
  type TestUser,
} from "./helpers.js";

/**
 * Cross-user isolation: user B must not be able to read or mutate user A's
 * resources. These lock in the per-user scoping the security audit verified.
 */
describe("authorization isolation", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    await resetDb();
    a = await createVerifiedUser();
    b = await createVerifiedUser();
  });

  it("hides A's collection from B (read, update, delete)", async () => {
    const created = await request(app())
      .post("/collections")
      .set(auth(a.accessToken))
      .send({ name: "A private" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await request(app()).get(`/collections/${id}`).set(auth(b.accessToken))).status).toBe(
      404,
    );
    expect(
      (
        await request(app())
          .patch(`/collections/${id}`)
          .set(auth(b.accessToken))
          .send({ name: "stolen" })
      ).status,
    ).toBe(404);
    expect(
      (await request(app()).delete(`/collections/${id}`).set(auth(b.accessToken))).status,
    ).toBe(404);

    // A still sees it untouched.
    const mine = await request(app()).get(`/collections/${id}`).set(auth(a.accessToken));
    expect(mine.status).toBe(200);
    expect(mine.body.name).toBe("A private");
  });

  it("keeps swipe history per user and blocks cross-user swipe edits", async () => {
    const [item] = await seedItems(1);
    const swipe = await request(app())
      .post("/swipes")
      .set(auth(a.accessToken))
      .send({ itemId: item.id, action: "LIKE" });
    expect(swipe.status).toBe(201);

    const bHistory = await request(app()).get("/swipes/history").set(auth(b.accessToken));
    expect(bHistory.status).toBe(200);
    expect(bHistory.body.swipes).toHaveLength(0);

    const bPatch = await request(app())
      .patch(`/swipes/${swipe.body.id}`)
      .set(auth(b.accessToken))
      .send({ action: "DISLIKE" });
    expect(bPatch.status).toBe(404);
  });

  it("hides A's conversations from non-participant B", async () => {
    const c = await createVerifiedUser();
    await makeFriends(a.id, c.id);

    const conv = await request(app())
      .post("/messages/conversations")
      .set(auth(a.accessToken))
      .send({ userId: c.id });
    expect([200, 201]).toContain(conv.status);
    const convId = conv.body.conversation.id as string;

    expect(
      (await request(app()).get(`/messages/conversations/${convId}`).set(auth(b.accessToken)))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app())
          .get(`/messages/conversations/${convId}/messages`)
          .set(auth(b.accessToken))
      ).status,
    ).toBe(404);
  });

  it("requires auth on user-scoped routers", async () => {
    for (const path of ["/collections", "/swipes/history", "/messages/conversations"]) {
      expect((await request(app()).get(path)).status).toBe(401);
    }
  });
});
