/**
 * Process-wide pino logger.
 *
 * - JSON output in production (Railway/log aggregators).
 * - Pretty output in dev via `pino-pretty` (loaded only when not production).
 * - Aggressive redaction of credentials and tokens — these must never appear
 *   in logs even by accident (e.g. someone logs `req.body` directly).
 *
 * Per-request loggers come from `pino-http`, which puts a child on `req.log`
 * pre-bound to `reqId`; route handlers should prefer `req.log` so the
 * request ID is in every line.
 */

import pino from "pino";

const NODE_ENV = process.env.NODE_ENV ?? "development";
const LOG_LEVEL = process.env.LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug");

const isProd = NODE_ENV === "production";
// pino-pretty is a worker_threads transport. In test runs the worker can be
// slow to spin down and adds flake; emit plain JSON instead. This also keeps
// `vitest` output clean of pretty-printed log noise.
const useTransport = !isProd && NODE_ENV !== "test";

export const REDACT_PATHS: string[] = [
  // Request side
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "req.body.password",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.refreshToken",
  "req.body.identityToken",
  "req.body.idToken",
  "req.body.token",
  // Response side
  'res.headers["set-cookie"]',
  // Generic — covers our own logger.{info,warn}({ password, ... }) calls
  "*.password",
  "*.refreshToken",
  "*.identityToken",
  "*.idToken",
  "*.passwordHash",
  "*.refreshTokenHash",
  "*.resetTokenHash",
];

export const logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: "[Redacted]",
    remove: false,
  },
  // Pretty in dev, JSON in prod/test. `pino-pretty` is a devDependency and
  // intentionally not loaded in production builds or under vitest.
  transport: useTransport
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});
