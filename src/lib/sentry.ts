/**
 * Sentry initialization + thin wrappers.
 *
 * Gated entirely on `SENTRY_DSN`. When the env var isn't set (local dev, CI,
 * fresh deploys before the Sentry project exists), nothing is initialized and
 * every helper is a no-op — the rest of the code can call into this module
 * unconditionally without sprouting `if (env.SENTRY_DSN)` everywhere.
 *
 * Errors are only sent in `setupExpressErrorHandler` (registered after
 * routes, before our custom error handler), filtered to 5xx so expected 4xx
 * validation/auth rejections don't pollute the issue feed.
 */

import * as Sentry from "@sentry/node";
import type { Express, Request } from "express";

let initialized = false;

export function initSentry(opts: {
  dsn: string | undefined;
  environment: string | undefined;
  tracesSampleRate: number;
  release?: string;
}): void {
  if (!opts.dsn) return;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    tracesSampleRate: opts.tracesSampleRate,
    release: opts.release,
    // Do not auto-attach IP, headers, cookies, etc. We attach `user.id` on
    // authenticated requests explicitly, and that's all the PII we want.
    sendDefaultPii: false,
    beforeSend(event) {
      // Belt + braces: even if something else attaches a request body to the
      // event, scrub anything that looks like a credential.
      if (event.request?.data && typeof event.request.data === "object") {
        const data = event.request.data as Record<string, unknown>;
        for (const k of [
          "password",
          "currentPassword",
          "newPassword",
          "refreshToken",
          "identityToken",
          "idToken",
          "token",
        ]) {
          if (k in data) data[k] = "[Redacted]";
        }
      }
      return event;
    },
  });
  initialized = true;
}

/** True iff `initSentry` actually configured a transport. */
export function isSentryEnabled(): boolean {
  return initialized;
}

/**
 * Wire Sentry's Express error handler. Captures only 5xx (4xx are expected
 * validation/auth rejections — `AppError` instances). Must be mounted after
 * all routes but before our custom error handler.
 */
export function attachSentryErrorHandler(app: Express): void {
  if (!initialized) return;
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError: (err) => {
      const status =
        (err as { statusCode?: number; status?: number }).statusCode ??
        (err as { status?: number }).status ??
        500;
      return status >= 500;
    },
  });
}

/** Bind the authenticated userId to the current request's Sentry scope. */
export function setSentryUser(req: Request, userId: string): void {
  if (!initialized) return;
  Sentry.getCurrentScope().setUser({ id: userId });
  // Attach the request id as a tag so the Sentry event links to a log line.
  if (typeof req.id === "string" || typeof req.id === "number") {
    Sentry.getCurrentScope().setTag("requestId", String(req.id));
  }
}
