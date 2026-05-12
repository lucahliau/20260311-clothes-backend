import { prisma } from "./prisma.js";

export async function isBlockedPair(a: string, b: string): Promise<boolean> {
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
  });
  return Boolean(block);
}

export type UserBlockRow = { blockerId: string; blockedId: string };

/**
 * Pure reducer: given the set of UserBlock rows touching `userId`, return the
 * set of *other* user IDs that should be invisible to `userId` — the union of
 * everyone they've blocked and everyone who's blocked them.
 *
 * Self IDs are stripped defensively in case a self-block row ever slips in.
 */
export function blockedUserIdsFromRows(userId: string, rows: UserBlockRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.blockerId !== userId) set.add(r.blockerId);
    if (r.blockedId !== userId) set.add(r.blockedId);
  }
  return set;
}

/**
 * One-query lookup of every user `userId` should not see (blocked + blocked-by).
 * Use this in list/feed handlers and pass the resulting set into Prisma
 * `notIn` filters — much cheaper than calling `isBlockedPair` per row.
 *
 * For single-pair gates (open a thread, send a follow), keep using
 * `isBlockedPair`.
 */
export async function getBlockedUserIdSet(userId: string): Promise<Set<string>> {
  const rows = await prisma.userBlock.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return blockedUserIdsFromRows(userId, rows);
}
