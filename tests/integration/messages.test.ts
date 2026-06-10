import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { prisma } from "../../src/lib/prisma.js";
import { app, auth, createVerifiedUser, makeFriends, resetDb, type TestUser } from "./helpers.js";

describe("messages", () => {
  let a: TestUser;
  let b: TestUser;
  let convId: string;

  beforeAll(async () => {
    await resetDb();
    a = await createVerifiedUser();
    b = await createVerifiedUser();
    await makeFriends(a.id, b.id);
  });

  it("requires friendship to open a conversation", async () => {
    const stranger = await createVerifiedUser();
    const res = await request(app())
      .post("/messages/conversations")
      .set(auth(a.accessToken))
      .send({ userId: stranger.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_FRIENDS");
  });

  it("creates a conversation once and returns the same thread on repeat", async () => {
    const first = await request(app())
      .post("/messages/conversations")
      .set(auth(a.accessToken))
      .send({ userId: b.id });
    expect(first.status).toBe(201);
    convId = first.body.conversation.id;

    const again = await request(app())
      .post("/messages/conversations")
      .set(auth(b.accessToken))
      .send({ userId: a.id });
    expect(again.status).toBe(200);
    expect(again.body.conversation.id).toBe(convId);
  });

  it("counts unread per conversation in the list (grouped query) and clears on read", async () => {
    for (const text of ["hey", "are you there?", "look at this"]) {
      const sent = await request(app())
        .post(`/messages/conversations/${convId}/messages`)
        .set(auth(a.accessToken))
        .send({ content: text });
      expect(sent.status).toBe(201);
    }

    const bList = await request(app()).get("/messages/conversations").set(auth(b.accessToken));
    expect(bList.status).toBe(200);
    expect(bList.body.total).toBe(1);
    expect(bList.body.items[0].unreadCount).toBe(3);
    expect(bList.body.items[0].lastMessage.content).toBe("look at this");
    // Sender's own messages are never "unread" for the sender.
    const aList = await request(app()).get("/messages/conversations").set(auth(a.accessToken));
    expect(aList.body.items[0].unreadCount).toBe(0);

    const read = await request(app())
      .patch(`/messages/conversations/${convId}/read`)
      .set(auth(b.accessToken));
    expect(read.status).toBe(200);

    const afterRead = await request(app()).get("/messages/conversations").set(auth(b.accessToken));
    expect(afterRead.body.items[0].unreadCount).toBe(0);
  });

  it("paginates a thread with a cursor", async () => {
    for (let i = 0; i < 22; i++) {
      const sent = await request(app())
        .post(`/messages/conversations/${convId}/messages`)
        .set(auth(b.accessToken))
        .send({ content: `msg ${i}` });
      expect(sent.status).toBe(201);
    }

    const page1 = await request(app())
      .get(`/messages/conversations/${convId}/messages`)
      .set(auth(a.accessToken));
    expect(page1.status).toBe(200);
    expect(page1.body.messages).toHaveLength(20);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app())
      .get(`/messages/conversations/${convId}/messages?cursor=${page1.body.nextCursor}`)
      .set(auth(a.accessToken));
    expect(page2.status).toBe(200);
    expect(page2.body.messages.length).toBeGreaterThan(0);
    expect(page2.body.hasMore).toBe(false);

    const ids1 = page1.body.messages.map((m: { id: string }) => m.id);
    const ids2 = page2.body.messages.map((m: { id: string }) => m.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it("soft-deletes own messages only", async () => {
    const sent = await request(app())
      .post(`/messages/conversations/${convId}/messages`)
      .set(auth(a.accessToken))
      .send({ content: "to be deleted" });
    const messageId = sent.body.message.id as string;

    const byOther = await request(app())
      .delete(`/messages/messages/${messageId}`)
      .set(auth(b.accessToken));
    expect(byOther.status).toBe(403);

    const byOwner = await request(app())
      .delete(`/messages/messages/${messageId}`)
      .set(auth(a.accessToken));
    expect(byOwner.status).toBe(200);
  });

  it("blocks access to the thread for a blocked pair", async () => {
    await prisma.userBlock.create({ data: { blockerId: a.id, blockedId: b.id } });

    const byBlocked = await request(app())
      .get(`/messages/conversations/${convId}`)
      .set(auth(b.accessToken));
    expect(byBlocked.status).toBe(403);
    expect(byBlocked.body.error.code).toBe("BLOCKED");

    // The conversation also disappears from both list views.
    const bList = await request(app()).get("/messages/conversations").set(auth(b.accessToken));
    expect(bList.body.total).toBe(0);
  });
});
