import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { isBlockedPair, getBlockedUserIdSet } from "../lib/social.js";
import { cdnImageUrl } from "../lib/imageCdn.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { sendPushToUser } from "../lib/apns.js";

const router = Router();

/** Express 5 types params as string | string[] */
function routeParam(req: Request, key: string): string {
  const v = req.params[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  throw new AppError(400, "BAD_REQUEST", "Invalid route parameter");
}

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

function pairKeyFor(a: string, b: string): string {
  return [a, b].sort().join("_");
}

async function findUserOrThrow(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }
  return user;
}

async function assertFriendship(me: string, otherId: string) {
  const friend = await prisma.friendRequest.findFirst({
    where: {
      status: "ACCEPTED",
      OR: [
        { fromUserId: me, toUserId: otherId },
        { fromUserId: otherId, toUserId: me },
      ],
    },
  });
  if (!friend) {
    throw new AppError(403, "NOT_FRIENDS", "You can only message friends");
  }
}

async function getParticipantOrThrow(conversationId: string, userId: string) {
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "Conversation not found");
  }
  return row;
}

/** Blocked users cannot access an existing DM thread. */
async function assertNotBlockedInConversation(me: string, conversationId: string) {
  const parts = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  const other = parts.find((p) => p.userId !== me)?.userId;
  if (other && (await isBlockedPair(me, other))) {
    throw new AppError(403, "BLOCKED", "You cannot access this conversation");
  }
}

async function unreadCountForMembership(
  conversationId: string,
  userId: string,
  lastReadAt: Date | null,
): Promise<number> {
  const since = lastReadAt ?? new Date(0);
  return prisma.message.count({
    where: {
      conversationId,
      senderId: { not: userId },
      deletedAt: null,
      createdAt: { gt: since },
    },
  });
}

/**
 * Unread counts for many conversations in one grouped query (the naive
 * per-conversation COUNT turns a 50-thread inbox into 50 queries). Joins
 * ConversationParticipant for the viewer's per-thread lastReadAt. Quoted
 * identifiers are Prisma's defaults — the schema declares no @map.
 */
async function unreadCountsByConversation(
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
    SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS unread
    FROM "Message" m
    JOIN "ConversationParticipant" cp
      ON cp."conversationId" = m."conversationId" AND cp."userId" = ${userId}
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."senderId" <> ${userId}
      AND m."deletedAt" IS NULL
      AND m."createdAt" > COALESCE(cp."lastReadAt", to_timestamp(0))
    GROUP BY m."conversationId"
  `;
  return new Map(rows.map((r) => [r.conversationId, r.unread]));
}

async function totalUnreadAcrossConversations(userId: string): Promise<number> {
  const blocked = [...(await getBlockedUserIdSet(userId))];
  const memberships = await prisma.conversationParticipant.findMany({
    where: {
      userId,
      // Hide conversations that contain any user the viewer can't see.
      // `none` with an empty `in` set is vacuously true (no filtering applied).
      conversation: { participants: { none: { userId: { in: blocked } } } },
    },
    select: { conversationId: true, lastReadAt: true },
  });
  const counts = await unreadCountsByConversation(
    userId,
    memberships.map((m) => m.conversationId),
  );
  let total = 0;
  for (const unread of counts.values()) total += unread;
  return total;
}

const listConversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createConversationBody = z.object({
  userId: z.string().uuid(),
});

const messagesQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const sendMessageBody = z
  .object({
    content: z.string().max(8000).optional(),
    itemId: z.string().uuid().optional(),
  })
  .refine((v) => (v.content != null && v.content.trim().length > 0) || v.itemId != null, {
    message: "Provide content and/or itemId",
  });

const itemPreviewSelect = {
  id: true,
  name: true,
  brand: true,
  imageUrl: true,
  price: true,
  currency: true,
  sourceUrl: true,
} as const;

function serializeMessage(
  m: {
    id: string;
    conversationId: string;
    senderId: string;
    content: string | null;
    itemId: string | null;
    deletedAt: Date | null;
    createdAt: Date;
    item?: {
      id: string;
      name: string;
      brand: string;
      imageUrl: string;
      price: unknown;
      currency: string;
      sourceUrl: string | null;
    } | null;
  },
  viewerId: string,
) {
  if (m.deletedAt) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      deleted: true as const,
      createdAt: m.createdAt.toISOString(),
    };
  }
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    content: m.content,
    itemId: m.itemId,
    item: m.item ? { ...m.item, imageUrl: cdnImageUrl(m.item.imageUrl) ?? m.item.imageUrl } : null,
    createdAt: m.createdAt.toISOString(),
    isOwn: m.senderId === viewerId,
  };
}

// ---------------------------------------------------------------------------
// GET /messages/conversations
// ---------------------------------------------------------------------------

router.get("/conversations", requireAuth, async (req: Request, res: Response) => {
  const me = req.user!.userId;
  const { limit, offset } = listConversationsQuery.parse(req.query);
  const blocked = [...(await getBlockedUserIdSet(me))];

  // Hide every conversation that contains a user the viewer can't see (in
  // either direction). For 1:1 threads this is the counterparty; for any
  // future group threads it also hides groups containing a blocked member.
  const where = {
    userId: me,
    conversation: { participants: { none: { userId: { in: blocked } } } },
  };

  const [total, memberships] = await prisma.$transaction([
    prisma.conversationParticipant.count({ where }),
    prisma.conversationParticipant.findMany({
      where,
      orderBy: { conversation: { updatedAt: "desc" } },
      take: limit,
      skip: offset,
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { omit: PUBLIC_USER_OMIT } },
            },
            messages: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              include: {
                item: { select: itemPreviewSelect },
              },
            },
          },
        },
      },
    }),
  ]);

  // One grouped query for all unread counts (was one COUNT per conversation).
  const unreadByConversation = await unreadCountsByConversation(
    me,
    memberships.map((row) => row.conversationId),
  );

  const items = memberships.map((row) => {
    const conv = row.conversation;
    const other = conv.participants.find((p) => p.userId !== me)?.user;
    const last = conv.messages[0];
    const unread = unreadByConversation.get(conv.id) ?? 0;

    let lastPreview: Record<string, unknown> | null = null;
    if (last) {
      if (last.deletedAt) {
        lastPreview = {
          id: last.id,
          deleted: true,
          createdAt: last.createdAt.toISOString(),
        };
      } else {
        lastPreview = {
          id: last.id,
          content: last.content,
          itemId: last.itemId,
          item: last.item
            ? { ...last.item, imageUrl: cdnImageUrl(last.item.imageUrl) ?? last.item.imageUrl }
            : null,
          senderId: last.senderId,
          createdAt: last.createdAt.toISOString(),
        };
      }
    }

    return {
      conversation: {
        id: conv.id,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
      },
      otherUser: other ? previewUser(other) : null,
      lastMessage: lastPreview,
      unreadCount: unread,
    };
  });

  res.json({ total, items });
});

// ---------------------------------------------------------------------------
// POST /messages/conversations
// ---------------------------------------------------------------------------

router.post("/conversations", requireAuth, async (req: Request, res: Response) => {
  const me = req.user!.userId;
  const { userId: otherId } = createConversationBody.parse(req.body);

  if (otherId === me) {
    throw new AppError(400, "BAD_REQUEST", "Cannot message yourself");
  }

  await findUserOrThrow(otherId);

  if (await isBlockedPair(me, otherId)) {
    throw new AppError(403, "BLOCKED", "You cannot message this user");
  }

  await assertFriendship(me, otherId);

  const pairKey = pairKeyFor(me, otherId);
  const existing = await prisma.conversation.findUnique({
    where: { pairKey },
    include: {
      participants: {
        include: { user: { omit: PUBLIC_USER_OMIT } },
      },
    },
  });

  if (existing) {
    const other = existing.participants.find((p) => p.userId !== me)?.user;
    res.json({
      conversation: {
        id: existing.id,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      },
      otherUser: other ? previewUser(other) : null,
    });
    return;
  }

  try {
    const newId = await prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.create({ data: { pairKey } });
      await tx.conversationParticipant.createMany({
        data: [
          { conversationId: conv.id, userId: me },
          { conversationId: conv.id, userId: otherId },
        ],
      });
      return conv.id;
    });

    const created = await prisma.conversation.findUniqueOrThrow({
      where: { id: newId },
      include: {
        participants: {
          include: { user: { omit: PUBLIC_USER_OMIT } },
        },
      },
    });

    const other = created.participants.find((p) => p.userId !== me)?.user;
    res.status(201).json({
      conversation: {
        id: created.id,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      otherUser: other ? previewUser(other) : null,
    });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      const conv = await prisma.conversation.findUnique({
        where: { pairKey },
        include: {
          participants: {
            include: { user: { omit: PUBLIC_USER_OMIT } },
          },
        },
      });
      if (!conv) throw e;
      const other = conv.participants.find((p) => p.userId !== me)?.user;
      res.json({
        conversation: {
          id: conv.id,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
        },
        otherUser: other ? previewUser(other) : null,
      });
      return;
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /messages/conversations/:conversationId
// ---------------------------------------------------------------------------

router.get("/conversations/:conversationId", requireAuth, async (req: Request, res: Response) => {
  const me = req.user!.userId;
  const conversationId = routeParam(req, "conversationId");

  await getParticipantOrThrow(conversationId, me);
  await assertNotBlockedInConversation(me, conversationId);

  const conv = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: {
      participants: {
        include: { user: { omit: PUBLIC_USER_OMIT } },
      },
    },
  });

  const other = conv.participants.find((p) => p.userId !== me)?.user;
  const myRow = conv.participants.find((p) => p.userId === me)!;
  const unread = await unreadCountForMembership(conv.id, me, myRow.lastReadAt);

  res.json({
    conversation: {
      id: conv.id,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    participants: conv.participants.map((p) => ({
      user: previewUser(p.user),
      lastReadAt: p.lastReadAt?.toISOString() ?? null,
    })),
    otherUser: other ? previewUser(other) : null,
    unreadCount: unread,
  });
});

// ---------------------------------------------------------------------------
// GET /messages/conversations/:conversationId/messages
// ---------------------------------------------------------------------------

router.get(
  "/conversations/:conversationId/messages",
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.user!.userId;
    const conversationId = routeParam(req, "conversationId");
    const { cursor, limit } = messagesQuery.parse(req.query);

    await getParticipantOrThrow(conversationId, me);
    await assertNotBlockedInConversation(me, conversationId);

    let cursorMsg: { id: string; createdAt: Date; conversationId: string } | null = null;
    if (cursor) {
      cursorMsg = await prisma.message.findUnique({
        where: { id: cursor },
        select: { id: true, createdAt: true, conversationId: true },
      });
      if (!cursorMsg || cursorMsg.conversationId !== conversationId) {
        throw new AppError(400, "BAD_REQUEST", "Invalid cursor");
      }
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        ...(cursorMsg
          ? {
              OR: [
                { createdAt: { lt: cursorMsg.createdAt } },
                {
                  AND: [{ createdAt: cursorMsg.createdAt }, { id: { lt: cursorMsg.id } }],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        item: { select: itemPreviewSelect },
      },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

    res.json({
      messages: page.map((m) => serializeMessage(m, me)),
      nextCursor,
      hasMore,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /messages/conversations/:conversationId/messages
// ---------------------------------------------------------------------------

router.post(
  "/conversations/:conversationId/messages",
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.user!.userId;
    const conversationId = routeParam(req, "conversationId");
    const body = sendMessageBody.parse(req.body);
    const content =
      body.content != null && body.content.trim().length > 0 ? body.content.trim() : undefined;

    await getParticipantOrThrow(conversationId, me);
    await assertNotBlockedInConversation(me, conversationId);

    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    if (participants.length !== 2) {
      throw new AppError(500, "INTERNAL_ERROR", "Invalid conversation");
    }

    const recipientId = participants.find((p) => p.userId !== me)?.userId;
    if (!recipientId) {
      throw new AppError(500, "INTERNAL_ERROR", "Invalid conversation");
    }

    if (body.itemId) {
      const item = await prisma.clothingItem.findUnique({ where: { id: body.itemId } });
      if (!item) {
        throw new AppError(404, "NOT_FOUND", "Item not found");
      }
    }

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          conversationId,
          senderId: me,
          content: content ?? null,
          itemId: body.itemId ?? null,
        },
        include: {
          item: { select: itemPreviewSelect },
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      return msg;
    });

    const sender = await prisma.user.findUniqueOrThrow({
      where: { id: me },
      select: { username: true },
    });

    const badge = await totalUnreadAcrossConversations(recipientId);

    try {
      await sendPushToUser(recipientId, {
        alert: {
          title: sender.username ? `@${sender.username}` : "New message",
          body: content ?? "Sent you a product",
        },
        badge,
        data: {
          type: "dm_message",
          conversationId,
          messageId: message.id,
        },
      });
    } catch (err) {
      req.log.warn({ err }, "[messages] Push notification failed");
    }

    res.status(201).json({ message: serializeMessage(message, me) });
  },
);

// ---------------------------------------------------------------------------
// PATCH /messages/conversations/:conversationId/read
// ---------------------------------------------------------------------------

router.patch(
  "/conversations/:conversationId/read",
  requireAuth,
  async (req: Request, res: Response) => {
    const me = req.user!.userId;
    const conversationId = routeParam(req, "conversationId");

    await getParticipantOrThrow(conversationId, me);
    await assertNotBlockedInConversation(me, conversationId);

    const now = new Date();
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: me } },
      data: { lastReadAt: now },
    });

    res.json({ readAt: now.toISOString() });
  },
);

// ---------------------------------------------------------------------------
// DELETE /messages/messages/:messageId
// ---------------------------------------------------------------------------

router.delete("/messages/:messageId", requireAuth, async (req: Request, res: Response) => {
  const me = req.user!.userId;
  const messageId = routeParam(req, "messageId");

  const msg = await prisma.message.findUnique({
    where: { id: messageId },
  });
  if (!msg) {
    throw new AppError(404, "NOT_FOUND", "Message not found");
  }
  if (msg.senderId !== me) {
    throw new AppError(403, "FORBIDDEN", "You can only delete your own messages");
  }

  await getParticipantOrThrow(msg.conversationId, me);
  await assertNotBlockedInConversation(me, msg.conversationId);

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), content: null, itemId: null },
  });

  res.json({
    message: {
      id: updated.id,
      conversationId: updated.conversationId,
      senderId: updated.senderId,
      deleted: true as const,
      createdAt: updated.createdAt.toISOString(),
    },
  });
});

export default router;
