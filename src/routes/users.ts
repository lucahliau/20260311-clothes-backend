import { Router, Request, Response } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import {
  createAvatarUploadUrl,
  avatarPublicPrefix,
  avatarPathFromPublicUrl,
  removeAvatarObject,
} from "../lib/supabase.js";
import { deleteAllSessionsForUser } from "../lib/sessions.js";
import { sendAccountDeletedEmail } from "../lib/email.js";
import { AppError } from "../middleware/error.js";
import { searchLimiter } from "../middleware/rateLimit.js";
import { isBlockedPair } from "../lib/social.js";
import { warmUserClusters } from "../services/feed-personalization.js";

const router = Router();

const PRIVATE_FIELDS = {
  passwordHash: true,
  refreshTokenHash: true,
  resetTokenHash: true,
  resetTokenExpiry: true,
} as const;

const updateProfileSchema = z
  .object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    avatarUrl: z.string().url().optional(),
    dateOfBirth: z
      .string()
      .transform((s) => new Date(s))
      .optional(),
    gender: z.string().max(50).optional(),
    location: z.string().max(200).optional(),
    bio: z.string().max(500).optional(),
    stylePreferences: z.array(z.string()).optional(),
    favoriteBrands: z.array(z.string()).optional(),
    preferredSizes: z.record(z.string(), z.string()).optional(),
    onboardingCompleted: z.boolean().optional(),
    profileIsPrivate: z.boolean().optional(),
  })
  .strict();

const onboardingSchema = z.object({
  stylePreferences: z.array(z.string()).min(1, "Select at least one style preference"),
  favoriteBrands: z.array(z.string()),
  preferredSizes: z.record(z.string(), z.string()),
  gender: z.string().max(50).optional(),
});

const deviceTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios"]).default("ios"),
});

const avatarUploadSchema = z.object({
  fileExt: z.enum(["jpg", "jpeg", "png", "webp", "heic"]).default("jpg"),
});

const usernameParamSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_]+$/, "Invalid username");

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});

function buildUserSearchWhere(q: string): Prisma.UserWhereInput {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  const orParts: Prisma.UserWhereInput[] = [
    { username: { contains: q, mode: "insensitive" } },
    { firstName: { contains: q, mode: "insensitive" } },
    { lastName: { contains: q, mode: "insensitive" } },
  ];
  if (terms.length >= 2) {
    orParts.push({
      AND: [
        { firstName: { contains: terms[0], mode: "insensitive" } },
        { lastName: { contains: terms[terms.length - 1]!, mode: "insensitive" } },
      ],
    });
  }
  return { OR: orParts };
}

async function buildRelationship(viewerId: string | undefined, targetId: string) {
  if (!viewerId || viewerId === targetId) {
    return null;
  }

  const [followOut, followIn, friendRow] = await Promise.all([
    prisma.follow.findUnique({
      where: { followerId_followeeId: { followerId: viewerId, followeeId: targetId } },
    }),
    prisma.follow.findUnique({
      where: { followerId_followeeId: { followerId: targetId, followeeId: viewerId } },
    }),
    prisma.friendRequest.findFirst({
      where: {
        OR: [
          { fromUserId: viewerId, toUserId: targetId },
          { fromUserId: targetId, toUserId: viewerId },
        ],
      },
    }),
  ]);

  const mapFollow = (row: { status: string } | null) =>
    !row
      ? "none"
      : row.status === "ACCEPTED"
        ? "accepted"
        : row.status === "PENDING"
          ? "pending"
          : "none";

  let friendship: "none" | "pending_out" | "pending_in" | "friends" = "none";
  if (friendRow) {
    if (friendRow.status === "ACCEPTED") friendship = "friends";
    else if (friendRow.status === "PENDING") {
      friendship = friendRow.fromUserId === viewerId ? "pending_out" : "pending_in";
    }
  }

  return {
    followAsViewer: mapFollow(followOut),
    followFromTarget: mapFollow(followIn),
    friendship,
  };
}

// ---------------------------------------------------------------------------
// GET /users/me
// ---------------------------------------------------------------------------

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  // The app hits /users/me at every launch — piggyback a non-blocking
  // personalized-feed cluster warm-up so a post-restart cold build happens
  // during the splash, not on the first /items/feed.
  warmUserClusters(req.user!.userId);

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    omit: PRIVATE_FIELDS,
  });

  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  res.json(user);
});

// ---------------------------------------------------------------------------
// PATCH /users/me
// ---------------------------------------------------------------------------

router.patch("/me", requireAuth, async (req: Request, res: Response) => {
  const data = updateProfileSchema.parse(req.body);

  if (Object.keys(data).length === 0) {
    throw new AppError(400, "BAD_REQUEST", "No fields to update");
  }

  // Avatars must be objects THIS account uploaded to our bucket — not an
  // arbitrary URL and not another user's object. Skipped when Supabase isn't
  // configured (nothing to validate against; uploads are impossible anyway).
  let previousAvatarUrl: string | null = null;
  if (data.avatarUrl !== undefined && avatarPublicPrefix() !== null) {
    const path = avatarPathFromPublicUrl(data.avatarUrl);
    if (!path || !path.startsWith(`${req.user!.userId}/`)) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        "avatarUrl must be an avatar uploaded by this account",
      );
    }
    const before = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { avatarUrl: true },
    });
    previousAvatarUrl = before?.avatarUrl ?? null;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data,
    omit: PRIVATE_FIELDS,
  });

  // Best-effort cleanup of the replaced avatar object; never fails the request.
  if (previousAvatarUrl && previousAvatarUrl !== user.avatarUrl) {
    const oldPath = avatarPathFromPublicUrl(previousAvatarUrl);
    if (oldPath) void removeAvatarObject(oldPath);
  }

  res.json(user);
});

// ---------------------------------------------------------------------------
// DELETE /users/me
// ---------------------------------------------------------------------------

router.delete("/me", requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { email: true, avatarUrl: true },
  });
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  // Revoke refresh tokens before the row goes away — the cascade would get
  // them anyway, but this makes the cutoff immediate and explicit.
  await deleteAllSessionsForUser(req.user!.userId);
  await prisma.user.delete({ where: { id: req.user!.userId } });

  // Best-effort: orphaned-avatar cleanup + farewell confirmation.
  if (user.avatarUrl) {
    const path = avatarPathFromPublicUrl(user.avatarUrl);
    if (path) void removeAvatarObject(path);
  }
  void sendAccountDeletedEmail(user.email);

  res.json({ message: "Account deleted" });
});

// ---------------------------------------------------------------------------
// POST /users/me/onboarding
// ---------------------------------------------------------------------------

router.post("/me/onboarding", requireAuth, async (req: Request, res: Response) => {
  const data = onboardingSchema.parse(req.body);

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      stylePreferences: data.stylePreferences,
      favoriteBrands: data.favoriteBrands,
      preferredSizes: data.preferredSizes,
      gender: data.gender,
      onboardingCompleted: true,
    },
    omit: PRIVATE_FIELDS,
  });

  res.json(user);
});

// ---------------------------------------------------------------------------
// POST /users/me/avatar-upload-url
// ---------------------------------------------------------------------------

router.post("/me/avatar-upload-url", requireAuth, async (req: Request, res: Response) => {
  const data = avatarUploadSchema.parse(req.body || {});

  try {
    const result = await createAvatarUploadUrl(req.user!.userId, data.fileExt);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create upload URL";
    throw new AppError(500, "UPLOAD_ERROR", message);
  }
});

// ---------------------------------------------------------------------------
// POST /users/me/device-tokens
// ---------------------------------------------------------------------------

router.post("/me/device-tokens", requireAuth, async (req: Request, res: Response) => {
  const data = deviceTokenSchema.parse(req.body);

  const existing = await prisma.deviceToken.findUnique({
    where: { token: data.token },
  });

  if (existing) {
    if (existing.userId !== req.user!.userId) {
      await prisma.deviceToken.update({
        where: { id: existing.id },
        data: { userId: req.user!.userId },
      });
    }
    res.json({ message: "Device token registered" });
    return;
  }

  await prisma.deviceToken.create({
    data: {
      userId: req.user!.userId,
      token: data.token,
      platform: data.platform,
    },
  });

  res.status(201).json({ message: "Device token registered" });
});

// ---------------------------------------------------------------------------
// DELETE /users/me/device-tokens/:token
// ---------------------------------------------------------------------------

router.delete("/me/device-tokens/:token", requireAuth, async (req: Request, res: Response) => {
  const token = req.params.token as string;

  const existing = await prisma.deviceToken.findUnique({ where: { token } });

  if (!existing || existing.userId !== req.user!.userId) {
    throw new AppError(404, "NOT_FOUND", "Device token not found");
  }

  await prisma.deviceToken.delete({ where: { id: existing.id } });

  res.json({ message: "Device token removed" });
});

// ---------------------------------------------------------------------------
// GET /users/search
// ---------------------------------------------------------------------------

router.get("/search", searchLimiter, optionalAuth, async (req: Request, res: Response) => {
  const { q, limit } = searchQuerySchema.parse(req.query);
  const viewerId = req.user?.userId;

  const baseWhere: Prisma.UserWhereInput = {
    AND: [
      buildUserSearchWhere(q),
      ...(viewerId ? [{ id: { not: viewerId } }] : []),
      ...(viewerId
        ? [
            {
              NOT: {
                OR: [
                  { blocksInitiated: { some: { blockedId: viewerId } } },
                  { blocksReceived: { some: { blockerId: viewerId } } },
                ],
              },
            },
          ]
        : []),
    ],
  };

  const rows = await prisma.user.findMany({
    where: baseWhere,
    take: limit,
    orderBy: { username: "asc" },
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      profileIsPrivate: true,
    },
  });

  res.json({ items: rows });
});

// ---------------------------------------------------------------------------
// GET /users/:username — public profile (optional auth for relationship)
// ---------------------------------------------------------------------------

router.get("/:username", optionalAuth, async (req: Request, res: Response) => {
  const username = usernameParamSchema.parse(req.params.username);
  const viewerId = req.user?.userId;

  const target = await prisma.user.findUnique({
    where: { username },
    omit: PRIVATE_FIELDS,
  });

  if (!target) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  if (viewerId && (await isBlockedPair(viewerId, target.id))) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  const [followerCount, followingCount, relationship] = await Promise.all([
    prisma.follow.count({ where: { followeeId: target.id, status: "ACCEPTED" } }),
    prisma.follow.count({ where: { followerId: target.id, status: "ACCEPTED" } }),
    buildRelationship(viewerId, target.id),
  ]);

  const isSelf = viewerId === target.id;
  const followAccepted =
    relationship?.followAsViewer === "accepted" || relationship?.followFromTarget === "accepted";
  const isFriend = relationship?.friendship === "friends";

  const canSeeFull = isSelf || !target.profileIsPrivate || followAccepted || isFriend;

  const full = {
    id: target.id,
    username: target.username,
    firstName: target.firstName,
    lastName: target.lastName,
    avatarUrl: target.avatarUrl,
    bio: target.bio,
    location: target.location,
    gender: target.gender,
    stylePreferences: target.stylePreferences,
    favoriteBrands: target.favoriteBrands,
    profileIsPrivate: target.profileIsPrivate,
    onboardingCompleted: target.onboardingCompleted,
    createdAt: target.createdAt,
    followerCount,
    followingCount,
    relationship: isSelf ? null : relationship,
  };

  if (canSeeFull) {
    res.json(full);
    return;
  }

  res.json({
    id: target.id,
    username: target.username,
    avatarUrl: target.avatarUrl,
    profileIsPrivate: true,
    followerCount,
    followingCount,
    relationship,
  });
});

export default router;
