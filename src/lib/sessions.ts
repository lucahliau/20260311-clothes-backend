/**
 * Per-device refresh-token sessions.
 *
 * One `Session` row per (userId, deviceId). On `/auth/refresh` the row is
 * rotated: the current `refreshTokenHash` moves to `previousRefreshTokenHash`
 * and a new hash is generated. The previous hash stays valid for a short
 * grace window so concurrent refresh requests (the common case on mobile,
 * when several queued requests all 401 at once) don't invalidate each other.
 *
 * The pure helpers below are split out so they can be unit-tested without
 * touching the database.
 */

import crypto from "crypto";
import { prisma } from "./prisma.js";

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ROTATION_GRACE_MS = 60 * 1000;                   // 60 seconds

export interface RefreshTokenPair {
  raw: string;
  hash: string;
}

export function generateRefreshTokenPair(): RefreshTokenPair {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Sliding 30-day expiry: every successful use pushes the deadline out. */
export function nextExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
}

/** True if a session's previous token is still within the rotation grace. */
export function withinRotationGrace(
  rotatedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!rotatedAt) return false;
  return now.getTime() - rotatedAt.getTime() <= ROTATION_GRACE_MS;
}

/** True if a session's expiry is in the past. */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export type SessionMatch = {
  id: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
};

/**
 * Look up a session by either its current refresh-token hash or its previous
 * hash (within the grace window). Returns null if no match — caller should
 * 401.
 */
export async function findSessionByRefreshHash(
  hash: string,
  now: Date = new Date(),
): Promise<SessionMatch | null> {
  // We can't use `findUnique` because the OR spans two unique indexes.
  const candidates = await prisma.session.findMany({
    where: {
      OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }],
    },
    select: {
      id: true,
      userId: true,
      deviceId: true,
      refreshTokenHash: true,
      previousRefreshTokenHash: true,
      rotatedAt: true,
      expiresAt: true,
    },
  });
  for (const s of candidates) {
    if (s.refreshTokenHash === hash) return s;
    // Previous-hash match is only valid for the grace window.
    if (s.previousRefreshTokenHash === hash && withinRotationGrace(s.rotatedAt, now)) {
      return s;
    }
  }
  return null;
}

/**
 * Create or replace the session for `(userId, deviceId)`. Used by every login
 * path (password, Apple, Google, register). Returns the new raw refresh token
 * — never stored.
 */
export async function upsertSessionForLogin(args: {
  userId: string;
  deviceId: string;
  userAgent?: string | null;
}): Promise<{ refreshToken: string; sessionId: string }> {
  const { userId, deviceId, userAgent } = args;
  const { raw, hash } = generateRefreshTokenPair();
  const now = new Date();
  const expiresAt = nextExpiresAt(now);
  const row = await prisma.session.upsert({
    where: { userId_deviceId: { userId, deviceId } },
    update: {
      refreshTokenHash: hash,
      previousRefreshTokenHash: null,
      rotatedAt: null,
      expiresAt,
      lastSeenAt: now,
      userAgent: userAgent ?? null,
    },
    create: {
      userId,
      deviceId,
      refreshTokenHash: hash,
      expiresAt,
      lastSeenAt: now,
      userAgent: userAgent ?? null,
    },
  });
  return { refreshToken: raw, sessionId: row.id };
}

/**
 * Rotate a session's refresh token: capture the current hash as `previous`,
 * install a new one, slide `expiresAt` forward. The previous hash stays valid
 * for the grace window so concurrent refreshes (multiple queued requests
 * 401-ing at once) all succeed.
 */
export async function rotateSession(
  sessionId: string,
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const { raw, hash } = generateRefreshTokenPair();
  const now = new Date();
  const expiresAt = nextExpiresAt(now);
  // Raw SQL because Prisma can't reference the current column value inside an
  // `update` (we need `previousRefreshTokenHash := refreshTokenHash`).
  await prisma.$executeRaw`
    UPDATE "Session"
    SET "previousRefreshTokenHash" = "refreshTokenHash",
        "refreshTokenHash" = ${hash},
        "rotatedAt" = ${now},
        "lastSeenAt" = ${now},
        "expiresAt" = ${expiresAt}
    WHERE "id" = ${sessionId}
  `;
  return { refreshToken: raw, expiresAt };
}

export async function deleteSessionById(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function deleteSessionByRefreshHash(hash: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }],
    },
  });
  return count;
}

export async function deleteSessionForDevice(
  userId: string,
  deviceId: string,
): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { userId, deviceId },
  });
  return count;
}

export async function deleteAllSessionsForUser(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}
