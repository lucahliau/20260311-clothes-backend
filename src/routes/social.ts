import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isBlockedPair as checkBlockedPair } from "../lib/social.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { notifySocialEvent } from "../lib/socialNotifications.js";
import type { FriendRequestStatus } from "../../generated/prisma/client.js";

const router = Router();

const PUBLIC_USER_OMIT = {
  passwordHash: true,
  refreshTokenHash: true,
  resetTokenHash: true,
  resetTokenExpiry: true,
  email: true,
} as const;

function previewUser(u: {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
}) {
  return {
    id: u.id,
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    avatarUrl: u.avatarUrl,
  };
}

async function findUserOrThrow(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }
  return user;
}

async function assertNotBlocked(viewerId: string, targetId: string) {
  if (await checkBlockedPair(viewerId, targetId)) {
    throw new AppError(403, "BLOCKED", "You cannot interact with this user");
  }
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// POST /social/follow/:userId
// ---------------------------------------------------------------------------

router.post("/follow/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  if (targetId === me) {
    throw new AppError(400, "BAD_REQUEST", "Cannot follow yourself");
  }

  await findUserOrThrow(targetId);
  await assertNotBlocked(me, targetId);

  const target = await prisma.user.findUniqueOrThrow({
    where: { id: targetId },
    select: { profileIsPrivate: true, username: true },
  });

  const existing = await prisma.follow.findUnique({
    where: { followerId_followeeId: { followerId: me, followeeId: targetId } },
  });

  if (existing?.status === "ACCEPTED") {
    res.json({ status: "accepted" as const, follow: existing });
    return;
  }

  if (existing?.status === "PENDING") {
    res.json({ status: "pending" as const, follow: existing });
    return;
  }

  if (existing?.status === "REJECTED") {
    await prisma.follow.delete({ where: { id: existing.id } });
  }

  const initialStatus = target.profileIsPrivate ? ("PENDING" as const) : ("ACCEPTED" as const);

  const follow = await prisma.follow.create({
    data: {
      followerId: me,
      followeeId: targetId,
      status: initialStatus,
      ...(initialStatus === "ACCEPTED" ? { respondedAt: new Date() } : {}),
    },
  });

  if (initialStatus === "PENDING") {
    const actor = await prisma.user.findUnique({
      where: { id: me },
      select: { username: true },
    });
    await notifySocialEvent(targetId, {
      title: "New follow request",
      body: actor?.username ? `@${actor.username} wants to follow you` : "Someone wants to follow you",
      data: { type: "follow_request", followerId: me },
    });
  }

  res.status(201).json({
    status: initialStatus === "ACCEPTED" ? ("accepted" as const) : ("pending" as const),
    follow,
  });
});

// ---------------------------------------------------------------------------
// DELETE /social/follow/:userId — unfollow or cancel outgoing follow request
// ---------------------------------------------------------------------------

router.delete("/follow/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  if (targetId === me) {
    throw new AppError(400, "BAD_REQUEST", "Invalid target");
  }

  const deleted = await prisma.follow.deleteMany({
    where: { followerId: me, followeeId: targetId },
  });

  res.json({ removed: deleted.count > 0 });
});

// ---------------------------------------------------------------------------
// POST /social/follow-requests/:followerId/accept
// ---------------------------------------------------------------------------

router.post("/follow-requests/:followerId/accept", requireAuth, async (req: Request, res: Response) => {
  const followerId = req.params.followerId as string;
  const me = req.user!.userId;

  if (followerId === me) {
    throw new AppError(400, "BAD_REQUEST", "Invalid follower");
  }

  const row = await prisma.follow.findUnique({
    where: { followerId_followeeId: { followerId, followeeId: me } },
  });

  if (!row || row.status !== "PENDING") {
    throw new AppError(404, "NOT_FOUND", "No pending follow request from this user");
  }

  const follow = await prisma.follow.update({
    where: { id: row.id },
    data: { status: "ACCEPTED", respondedAt: new Date() },
  });

  const accepter = await prisma.user.findUnique({
    where: { id: me },
    select: { username: true },
  });
  await notifySocialEvent(followerId, {
    title: "Follow request accepted",
    body: accepter?.username ? `@${accepter.username} accepted your follow request` : "Your follow request was accepted",
    data: { type: "follow_accepted", followeeId: me },
  });

  res.json({ follow });
});

// ---------------------------------------------------------------------------
// POST /social/follow-requests/:followerId/reject
// ---------------------------------------------------------------------------

router.post("/follow-requests/:followerId/reject", requireAuth, async (req: Request, res: Response) => {
  const followerId = req.params.followerId as string;
  const me = req.user!.userId;

  if (followerId === me) {
    throw new AppError(400, "BAD_REQUEST", "Invalid follower");
  }

  const deleted = await prisma.follow.deleteMany({
    where: { followerId, followeeId: me, status: "PENDING" },
  });

  if (deleted.count === 0) {
    throw new AppError(404, "NOT_FOUND", "No pending follow request from this user");
  }

  res.json({ rejected: true });
});

// ---------------------------------------------------------------------------
// POST /social/friends/request/:userId
// ---------------------------------------------------------------------------

router.post("/friends/request/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  if (targetId === me) {
    throw new AppError(400, "BAD_REQUEST", "Cannot friend yourself");
  }

  await findUserOrThrow(targetId);
  await assertNotBlocked(me, targetId);

  const reversePending = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId: targetId, toUserId: me } },
  });
  if (reversePending?.status === "PENDING") {
    throw new AppError(409, "CONFLICT", "This user already sent you a friend request — accept or decline it first");
  }

  const existing = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId: me, toUserId: targetId } },
  });

  if (existing?.status === "ACCEPTED") {
    throw new AppError(409, "CONFLICT", "You are already friends with this user");
  }

  if (existing?.status === "PENDING") {
    res.json({ friendRequest: existing });
    return;
  }

  if (existing && (existing.status === "DECLINED" || existing.status === "CANCELLED")) {
    await prisma.friendRequest.delete({ where: { id: existing.id } });
  }

  const friendRequest = await prisma.friendRequest.create({
    data: {
      fromUserId: me,
      toUserId: targetId,
      status: "PENDING",
    },
  });

  const actor = await prisma.user.findUnique({
    where: { id: me },
    select: { username: true },
  });
  await notifySocialEvent(targetId, {
    title: "New friend request",
    body: actor?.username ? `@${actor.username} sent you a friend request` : "You have a new friend request",
    data: { type: "friend_request", fromUserId: me },
  });

  res.status(201).json({ friendRequest });
});

// ---------------------------------------------------------------------------
// DELETE /social/friends/request/:userId — cancel outgoing friend request
// ---------------------------------------------------------------------------

router.delete("/friends/request/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  const deleted = await prisma.friendRequest.deleteMany({
    where: { fromUserId: me, toUserId: targetId, status: "PENDING" },
  });

  res.json({ cancelled: deleted.count > 0 });
});

// ---------------------------------------------------------------------------
// POST /social/friends/requests/:fromUserId/accept
// ---------------------------------------------------------------------------

router.post("/friends/requests/:fromUserId/accept", requireAuth, async (req: Request, res: Response) => {
  const fromUserId = req.params.fromUserId as string;
  const me = req.user!.userId;

  if (fromUserId === me) {
    throw new AppError(400, "BAD_REQUEST", "Invalid request");
  }

  const row = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId, toUserId: me } },
  });

  if (!row || row.status !== "PENDING") {
    throw new AppError(404, "NOT_FOUND", "No pending friend request from this user");
  }

  const friendRequest = await prisma.friendRequest.update({
    where: { id: row.id },
    data: { status: "ACCEPTED" satisfies FriendRequestStatus },
  });

  const accepter = await prisma.user.findUnique({
    where: { id: me },
    select: { username: true },
  });
  await notifySocialEvent(fromUserId, {
    title: "Friend request accepted",
    body: accepter?.username ? `@${accepter.username} accepted your friend request` : "Your friend request was accepted",
    data: { type: "friend_accepted", toUserId: me },
  });

  res.json({ friendRequest });
});

// ---------------------------------------------------------------------------
// POST /social/friends/requests/:fromUserId/decline
// ---------------------------------------------------------------------------

router.post("/friends/requests/:fromUserId/decline", requireAuth, async (req: Request, res: Response) => {
  const fromUserId = req.params.fromUserId as string;
  const me = req.user!.userId;

  const row = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId, toUserId: me } },
  });

  if (!row || row.status !== "PENDING") {
    throw new AppError(404, "NOT_FOUND", "No pending friend request from this user");
  }

  await prisma.friendRequest.update({
    where: { id: row.id },
    data: { status: "DECLINED" },
  });

  res.json({ declined: true });
});

// ---------------------------------------------------------------------------
// DELETE /social/friends/:userId — end friendship
// ---------------------------------------------------------------------------

router.delete("/friends/:userId", requireAuth, async (req: Request, res: Response) => {
  const otherId = req.params.userId as string;
  const me = req.user!.userId;

  if (otherId === me) {
    throw new AppError(400, "BAD_REQUEST", "Invalid target");
  }

  const deleted = await prisma.friendRequest.deleteMany({
    where: {
      status: "ACCEPTED",
      OR: [
        { fromUserId: me, toUserId: otherId },
        { fromUserId: otherId, toUserId: me },
      ],
    },
  });

  res.json({ removed: deleted.count > 0 });
});

// ---------------------------------------------------------------------------
// GET /social/followers
// ---------------------------------------------------------------------------

router.get("/followers", requireAuth, async (req: Request, res: Response) => {
  const { limit, offset } = paginationSchema.parse(req.query);
  const me = req.user!.userId;

  const [total, rows] = await prisma.$transaction([
    prisma.follow.count({ where: { followeeId: me, status: "ACCEPTED" } }),
    prisma.follow.findMany({
      where: { followeeId: me, status: "ACCEPTED" },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        follower: { omit: PUBLIC_USER_OMIT },
      },
    }),
  ]);

  res.json({
    total,
    items: rows.map((r) => previewUser(r.follower)),
  });
});

// ---------------------------------------------------------------------------
// GET /social/following
// ---------------------------------------------------------------------------

router.get("/following", requireAuth, async (req: Request, res: Response) => {
  const { limit, offset } = paginationSchema.parse(req.query);
  const me = req.user!.userId;

  const [total, rows] = await prisma.$transaction([
    prisma.follow.count({ where: { followerId: me, status: "ACCEPTED" } }),
    prisma.follow.findMany({
      where: { followerId: me, status: "ACCEPTED" },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        followee: { omit: PUBLIC_USER_OMIT },
      },
    }),
  ]);

  res.json({
    total,
    items: rows.map((r) => previewUser(r.followee)),
  });
});

// ---------------------------------------------------------------------------
// GET /social/friends
// ---------------------------------------------------------------------------

router.get("/friends", requireAuth, async (req: Request, res: Response) => {
  const { limit, offset } = paginationSchema.parse(req.query);
  const me = req.user!.userId;

  const whereAccepted = { status: "ACCEPTED" as const, OR: [{ fromUserId: me }, { toUserId: me }] };

  const [total, rows] = await prisma.$transaction([
    prisma.friendRequest.count({ where: whereAccepted }),
    prisma.friendRequest.findMany({
      where: whereAccepted,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        fromUser: { omit: PUBLIC_USER_OMIT },
        toUser: { omit: PUBLIC_USER_OMIT },
      },
    }),
  ]);

  const items = rows.map((r) => {
    const other = r.fromUserId === me ? r.toUser : r.fromUser;
    return previewUser(other);
  });

  res.json({ total, items });
});

// ---------------------------------------------------------------------------
// GET /social/pending
// ---------------------------------------------------------------------------

router.get("/pending", requireAuth, async (req: Request, res: Response) => {
  const me = req.user!.userId;

  const [incomingFollows, outgoingFollows, incomingFriends, outgoingFriends] = await Promise.all([
    prisma.follow.findMany({
      where: { followeeId: me, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { follower: { omit: PUBLIC_USER_OMIT } },
    }),
    prisma.follow.findMany({
      where: { followerId: me, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { followee: { omit: PUBLIC_USER_OMIT } },
    }),
    prisma.friendRequest.findMany({
      where: { toUserId: me, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { fromUser: { omit: PUBLIC_USER_OMIT } },
    }),
    prisma.friendRequest.findMany({
      where: { fromUserId: me, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { toUser: { omit: PUBLIC_USER_OMIT } },
    }),
  ]);

  res.json({
    incomingFollowRequests: incomingFollows.map((f) => ({
      follow: { id: f.id, createdAt: f.createdAt },
      user: previewUser(f.follower),
    })),
    outgoingFollowRequests: outgoingFollows.map((f) => ({
      follow: { id: f.id, createdAt: f.createdAt },
      user: previewUser(f.followee),
    })),
    incomingFriendRequests: incomingFriends.map((r) => ({
      friendRequest: { id: r.id, createdAt: r.createdAt },
      user: previewUser(r.fromUser),
    })),
    outgoingFriendRequests: outgoingFriends.map((r) => ({
      friendRequest: { id: r.id, createdAt: r.createdAt },
      user: previewUser(r.toUser),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /social/block/:userId
// ---------------------------------------------------------------------------

router.post("/block/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  if (targetId === me) {
    throw new AppError(400, "BAD_REQUEST", "Cannot block yourself");
  }

  await findUserOrThrow(targetId);

  await prisma.$transaction(async (tx) => {
    await tx.follow.deleteMany({
      where: {
        OR: [
          { followerId: me, followeeId: targetId },
          { followerId: targetId, followeeId: me },
        ],
      },
    });
    await tx.friendRequest.deleteMany({
      where: {
        OR: [
          { fromUserId: me, toUserId: targetId },
          { fromUserId: targetId, toUserId: me },
        ],
      },
    });
    await tx.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: me, blockedId: targetId } },
      create: { blockerId: me, blockedId: targetId },
      update: {},
    });
  });

  res.status(201).json({ blocked: true });
});

// ---------------------------------------------------------------------------
// DELETE /social/block/:userId
// ---------------------------------------------------------------------------

router.delete("/block/:userId", requireAuth, async (req: Request, res: Response) => {
  const targetId = req.params.userId as string;
  const me = req.user!.userId;

  const deleted = await prisma.userBlock.deleteMany({
    where: { blockerId: me, blockedId: targetId },
  });

  res.json({ unblocked: deleted.count > 0 });
});

export default router;
