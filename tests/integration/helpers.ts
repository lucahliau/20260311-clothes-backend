import request from "supertest";
import type { Express } from "express";
import { prisma } from "../../src/lib/prisma.js";
import { createApp } from "../../src/app.js";

let _app: Express | null = null;

/** One app per test file (modules are isolated per file). */
export function app(): Express {
  if (!_app) _app = createApp();
  return _app;
}

/** Wipe all app tables (keeps _prisma_migrations). CASCADE handles FK order. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "ConversationParticipant", "Conversation",
      "UserBlock", "FriendRequest", "Follow",
      "CollectionItem", "Collection", "Swipe",
      "ItemEmbedding", "ScrapedRaw", "DeviceToken", "Session",
      "AnalyticsEvent",
      "ClothingItem", "User"
    RESTART IDENTITY CASCADE
  `);
}

export interface TestUser {
  id: string;
  email: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let userSeq = 0;

/** Register via the API, mark the email verified directly, then log in. */
export async function createVerifiedUser(
  overrides: { email?: string; username?: string; password?: string } = {},
): Promise<TestUser> {
  userSeq += 1;
  const email = overrides.email ?? `user${userSeq}-${Date.now()}@test.dev`;
  const username = overrides.username ?? `user${userSeq}_${Date.now() % 100000}`;
  const password = overrides.password ?? "password123";

  const reg = await request(app()).post("/auth/register").send({ email, username, password });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const login = await request(app())
    .post("/auth/login")
    .send({ email, password, deviceId: `device-${userSeq}-abcdef` });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }

  return {
    id: login.body.user.id as string,
    email,
    username,
    password,
    accessToken: login.body.accessToken as string,
    refreshToken: login.body.refreshToken as string,
  };
}

export function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Seed N active catalog items directly (the crawler owns this table in prod). */
export async function seedItems(
  n: number,
  overrides: Partial<{ brand: string; category: string; gender: string }> = {},
) {
  const data = Array.from({ length: n }, (_, i) => ({
    name: `Item ${i}`,
    brand: overrides.brand ?? "TestBrand",
    category: overrides.category ?? "tops",
    price: 49.99,
    imageUrl: `https://img.test/i${i}.jpg`,
    gender: overrides.gender ?? "male",
    productType: "tops",
  }));
  await prisma.clothingItem.createMany({ data });
  return prisma.clothingItem.findMany({ orderBy: { createdAt: "asc" } });
}

/** Messaging requires an ACCEPTED friendship; create it directly. */
export async function makeFriends(userIdA: string, userIdB: string): Promise<void> {
  await prisma.friendRequest.create({
    data: { fromUserId: userIdA, toUserId: userIdB, status: "ACCEPTED" },
  });
}
