import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { createAvatarUploadUrl } from "../lib/supabase.js";

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
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

// ---------------------------------------------------------------------------
// PATCH /users/me
// ---------------------------------------------------------------------------

router.patch("/me", requireAuth, async (req: Request, res: Response) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: parsed.data,
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
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      stylePreferences: parsed.data.stylePreferences,
      favoriteBrands: parsed.data.favoriteBrands,
      preferredSizes: parsed.data.preferredSizes,
      gender: parsed.data.gender,
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
  const parsed = avatarUploadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const result = await createAvatarUploadUrl(req.user!.userId, parsed.data.fileExt);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create upload URL";
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /users/me/device-tokens
// ---------------------------------------------------------------------------

router.post("/me/device-tokens", requireAuth, async (req: Request, res: Response) => {
  const parsed = deviceTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const existing = await prisma.deviceToken.findUnique({
    where: { token: parsed.data.token },
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
      token: parsed.data.token,
      platform: parsed.data.platform,
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
    res.status(404).json({ error: "Device token not found" });
    return;
  }

  await prisma.deviceToken.delete({ where: { id: existing.id } });

  res.json({ message: "Device token removed" });
});

export default router;
