import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import * as jose from "jose";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { sendPasswordResetEmail } from "../lib/email.js";
import { env } from "../lib/env.js";
import { AppError } from "../middleware/error.js";

const router = Router();

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a consistent user object for auth responses (avoids Swift Codable "missing" errors) */
function toAuthUser(user: {
  id: string;
  email: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  dateOfBirth?: Date | null;
  gender?: string | null;
  location?: string | null;
  bio?: string | null;
  stylePreferences?: string[];
  favoriteBrands?: string[];
  preferredSizes?: unknown;
  onboardingCompleted?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
    gender: user.gender ?? null,
    location: user.location ?? null,
    bio: user.bio ?? null,
    stylePreferences: user.stylePreferences ?? [],
    favoriteBrands: user.favoriteBrands ?? [],
    preferredSizes: user.preferredSizes ?? null,
    onboardingCompleted: user.onboardingCompleted ?? false,
    createdAt: user.createdAt ? user.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: user.updatedAt ? user.updatedAt.toISOString() : new Date().toISOString(),
  };
}

function generateAccessToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, process.env.JWT_SECRET!, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

let _appleJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getAppleJwks() {
  if (!_appleJwks) {
    _appleJwks = jose.createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }
  return _appleJwks;
}

let _googleJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getGoogleJwks() {
  if (!_googleJwks) {
    _googleJwks = jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return _googleJwks;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, numbers, and underscores"),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const appleAuthSchema = z.object({
  identityToken: z.string(),
  fullName: z
    .object({
      givenName: z.string().optional(),
      familyName: z.string().optional(),
    })
    .optional(),
});

const googleAuthSchema = z.object({
  idToken: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(128),
});

const resetRequestSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(128),
});

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

router.post("/register", authLimiter, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { email, username, password } = registerSchema.parse(body);

  const existingUser = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });

  if (existingUser) {
    const field = existingUser.email === email ? "email" : "username";
    throw new AppError(409, "CONFLICT", `A user with that ${field} already exists`);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const refresh = generateRefreshToken();

  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash,
      refreshTokenHash: refresh.hash,
    },
  });

  const accessToken = generateAccessToken(user.id, user.email);

  res.status(201).json({
    user: toAuthUser(user),
    accessToken,
    refreshToken: refresh.raw,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

router.post("/login", authLimiter, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { email, password } = loginSchema.parse(body);

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid email or password");
  }

  const refresh = generateRefreshToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: refresh.hash },
  });

  const accessToken = generateAccessToken(user.id, user.email);

  res.json({
    user: toAuthUser(user),
    accessToken,
    refreshToken: refresh.raw,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };

  if (!refreshToken) {
    throw new AppError(400, "BAD_REQUEST", "refreshToken is required");
  }

  const hash = hashToken(refreshToken);

  const user = await prisma.user.findFirst({
    where: { refreshTokenHash: hash },
  });

  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid refresh token");
  }

  const newRefresh = generateRefreshToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: newRefresh.hash },
  });

  const accessToken = generateAccessToken(user.id, user.email);

  res.json({ accessToken, refreshToken: newRefresh.raw });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { refreshTokenHash: null },
  });

  res.json({ message: "Logged out" });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------

router.post("/forgot-password", authLimiter, async (req: Request, res: Response) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, "BAD_REQUEST", "A valid email is required");
  }

  // Always return 200 to avoid leaking whether the email exists
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  if (user) {
    const raw = crypto.randomBytes(32).toString("hex");
    const hash = hashToken(raw);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: hash,
        resetTokenExpiry: new Date(Date.now() + RESET_TOKEN_EXPIRY_MS),
      },
    });

    const baseUrl = env().APP_URL.replace(/\/$/, "");
    const resetUrl = `${baseUrl}/reset-password?token=${raw}`;
    await sendPasswordResetEmail(user.email, resetUrl);
  }

  res.json({ message: "If that email is registered, a reset link has been sent" });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

router.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  const hash = hashToken(token);

  const user = await prisma.user.findFirst({
    where: {
      resetTokenHash: hash,
      resetTokenExpiry: { gt: new Date() },
    },
  });

  if (!user) {
    throw new AppError(400, "BAD_REQUEST", "Invalid or expired reset token");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetTokenHash: null,
      resetTokenExpiry: null,
      refreshTokenHash: null, // invalidate all sessions
    },
  });

  res.json({ message: "Password has been reset. Please log in again." });
});

// ---------------------------------------------------------------------------
// POST /auth/apple
// ---------------------------------------------------------------------------
// iOS: ASAuthorizationAppleIDCredential.identityToken (JWT string). Body:
// { "identityToken": "<jwt>", "fullName": { "givenName"?, "familyName"? } } (fullName only on first sign-in).
// APPLE_CLIENT_ID must match the token audience (your App ID / bundle ID, or Services ID for web).

router.post("/apple", authLimiter, async (req: Request, res: Response) => {
  const { identityToken, fullName } = appleAuthSchema.parse(req.body);

  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Apple Sign-In is not configured");
  }

  let applePayload: jose.JWTPayload;
  try {
    const { payload } = await jose.jwtVerify(identityToken, getAppleJwks(), {
      issuer: APPLE_ISSUER,
      audience: clientId,
    });
    applePayload = payload;
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid Apple identity token");
  }

  const appleId = applePayload.sub;
  const appleEmail = applePayload.email as string | undefined;

  if (!appleId) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid Apple identity token: missing subject");
  }

  let user = await prisma.user.findUnique({ where: { appleId } });

  if (!user && appleEmail) {
    user = await prisma.user.findUnique({ where: { email: appleEmail } });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { appleId },
      });
    }
  }

  if (!user) {
    const email = appleEmail || `${appleId}@privaterelay.appleid.com`;
    const username = `user_${crypto.randomBytes(6).toString("hex")}`;

    user = await prisma.user.create({
      data: {
        email,
        username,
        appleId,
        firstName: fullName?.givenName ?? null,
        lastName: fullName?.familyName ?? null,
      },
    });
  }

  const refresh = generateRefreshToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: refresh.hash },
  });

  const accessToken = generateAccessToken(user.id, user.email);

  res.json({
    user: toAuthUser(user),
    accessToken,
    refreshToken: refresh.raw,
    isNewUser: !user.onboardingCompleted,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/google
// ---------------------------------------------------------------------------
// iOS: GIDSignIn idToken.tokenString. Body: { "idToken": "<jwt>" }.
// GOOGLE_CLIENT_ID must match the ID token aud (typically your iOS OAuth client ID from Google Cloud).

router.post("/google", authLimiter, async (req: Request, res: Response) => {
  const { idToken } = googleAuthSchema.parse(req.body);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Google Sign-In is not configured");
  }

  let googlePayload: jose.JWTPayload;
  try {
    const { payload } = await jose.jwtVerify(idToken, getGoogleJwks(), {
      issuer: [...GOOGLE_ISSUERS],
      audience: clientId,
    });
    googlePayload = payload;
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid Google ID token");
  }

  const googleId = googlePayload.sub;
  const googleEmail = googlePayload.email as string | undefined;
  const emailVerified =
    googlePayload.email_verified === true || googlePayload.email_verified === "true";

  if (!googleId) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid Google ID token: missing subject");
  }

  let user = await prisma.user.findUnique({ where: { googleId } });

  if (!user && googleEmail && emailVerified) {
    user = await prisma.user.findUnique({ where: { email: googleEmail } });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId },
      });
    }
  }

  if (!user) {
    const email = googleEmail || `google_${googleId}@placeholder.invalid`;
    const username = `user_${crypto.randomBytes(6).toString("hex")}`;
    const givenName = googlePayload.given_name as string | undefined;
    const familyName = googlePayload.family_name as string | undefined;

    user = await prisma.user.create({
      data: {
        email,
        username,
        googleId,
        firstName: givenName ?? null,
        lastName: familyName ?? null,
      },
    });
  }

  const refresh = generateRefreshToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: refresh.hash },
  });

  const accessToken = generateAccessToken(user.id, user.email);

  res.json({
    user: toAuthUser(user),
    accessToken,
    refreshToken: refresh.raw,
    isNewUser: !user.onboardingCompleted,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/change-password
// ---------------------------------------------------------------------------

router.post("/change-password", requireAuth, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user || !user.passwordHash) {
    throw new AppError(400, "BAD_REQUEST", "Password change not available for this account");
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "UNAUTHORIZED", "Current password is incorrect");
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  res.json({ message: "Password changed successfully" });
});

export default router;
