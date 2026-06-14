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

// Swipes arrive batched from the app (one request carries up to 100 swipes, and
// the client paces flushes), so this is a generous runaway-client backstop, not
// a per-swipe throttle like swipeLimiter. Per-user (must run after requireAuth).
// A fast swiper produces only a handful of batch requests per minute; 300 leaves
// large headroom for bursts/multi-device while still capping abuse.
export const swipeBatchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? "anon",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: { code: "RATE_LIMITED", message: "Too many swipes, slow down" } },
});

// Analytics events arrive batched (the app flushes up to 100 per request), so
// this is intentionally generous — it's a runaway-client backstop, not a
// throttle. Keyed per-user when authed, per-IP otherwise (events may be
// pre-login). Runs after optionalAuth.
export const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? "anon",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: { code: "RATE_LIMITED", message: "Too many analytics events" } },
});
