import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, type TestUser } from "./helpers.js";
import { prisma } from "../../src/lib/prisma.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("analytics", () => {
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
  });

  it("ingests a batch, tying events to the authed user", async () => {
    const res = await request(app())
      .post("/analytics/ingest")
      .set(auth(user.accessToken))
      .send({
        sessionId: SESSION_ID,
        events: [
          { eventName: "session_start", clientTs: new Date().toISOString() },
          { eventName: "screen_view", screenName: "Feed" },
          { eventName: "item_view", metadata: { itemId: "abc" } },
        ],
      });
    expect(res.status).toBe(202);
    expect(res.body.inserted).toBe(3);

    const rows = await prisma.analyticsEvent.findMany({ where: { sessionId: SESSION_ID } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.userId === user.id)).toBe(true);
    const screen = rows.find((r) => r.eventName === "screen_view");
    expect(screen?.screenName).toBe("Feed");
  });

  it("accepts events without auth (userId null)", async () => {
    const anonSession = "22222222-2222-4222-8222-222222222222";
    const res = await request(app())
      .post("/analytics/ingest")
      .send({ sessionId: anonSession, events: [{ eventName: "session_start" }] });
    expect(res.status).toBe(202);

    const row = await prisma.analyticsEvent.findFirst({ where: { sessionId: anonSession } });
    expect(row?.userId).toBeNull();
  });

  it("rejects unknown event names and malformed batches", async () => {
    const badName = await request(app())
      .post("/analytics/ingest")
      .set(auth(user.accessToken))
      .send({ sessionId: SESSION_ID, events: [{ eventName: "definitely_not_an_event" }] });
    expect(badName.status).toBe(400);

    const empty = await request(app())
      .post("/analytics/ingest")
      .set(auth(user.accessToken))
      .send({ sessionId: SESSION_ID, events: [] });
    expect(empty.status).toBe(400);

    const badSession = await request(app())
      .post("/analytics/ingest")
      .set(auth(user.accessToken))
      .send({ sessionId: "not-a-uuid", events: [{ eventName: "session_start" }] });
    expect(badSession.status).toBe(400);
  });
});
