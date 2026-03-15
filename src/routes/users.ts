import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { createAvatarUploadUrl } from "../lib/supabase.js";
import { AppError } from "../middleware/error.js";

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
    dateOfBirth: z.string().transform((s) => new Date(s)).optional(),
    gender: z.string().max(50).optional(),
    location: z.string().max(200).optional(),
    bio: z.string().max(500).optional(),
    stylePreferences: z.array(z.string()).optional(),
    favoriteBrands: z.array(z.string()).optional(),
    preferredSizes: z.record(z.string(), z.string()).optional(),
    onboardingCompleted: z.boolean().optional(),
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

// ---------------------------------------------------------------------------
// GET /users/me
// ---------------------------------------------------------------------------

router.get("/me", requireAuth, async (req: Request, res: Response) => {
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

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data,
    omit: PRIVATE_FIELDS,
  });

  res.json(user);
});

// ---------------------------------------------------------------------------
// DELETE /users/me
// ---------------------------------------------------------------------------

router.delete("/me", requireAuth, async (req: Request, res: Response) => {
  await prisma.user.delete({ where: { id: req.user!.userId } });
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

export default router;
