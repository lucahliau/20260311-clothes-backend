import rateLimit from "express-rate-limit";
import { env } from "../lib/env.js";

// Integration tests drive every request from one IP; per-IP limits would make
// the suite order-dependent and flaky. Evaluated per request, so production
// (NODE_ENV !== "test") is unaffected.
const skipInTests = () => env().NODE_ENV === "test";

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: { code: "RATE_LIMITED", message: "Too many requests, please try again later" },
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: { code: "RATE_LIMITED", message: "Too many attempts, please try again later" },
  },
});

export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: { code: "RATE_LIMITED", message: "Too many search requests, slow down" } },
});

// Per-user (not per-IP) so a single account can't inflate "likes" or fan out
// APNS match notifications by rotating IPs. Must run AFTER requireAuth.
export const swipeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? "anon",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: { code: "RATE_LIMITED", message: "Too many swipes, slow down" } },
});
