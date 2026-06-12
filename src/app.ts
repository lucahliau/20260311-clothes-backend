import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "crypto";
import { pinoHttp } from "pino-http";

import { env, getAppleUniversalLinkAppId } from "./lib/env.js";
import { buildAppleAppSiteAssociation } from "./lib/appleAppSiteAssociation.js";
import { logger, REDACT_PATHS } from "./lib/logger.js";
import { attachSentryErrorHandler } from "./lib/sentry.js";
import { prisma } from "./lib/prisma.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/error.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import itemsRouter from "./routes/items.js";
import brandsRouter from "./routes/brands.js";
import swipesRouter from "./routes/swipes.js";
import collectionsRouter from "./routes/collections.js";
import socialRouter from "./routes/social.js";
import messagesRouter from "./routes/messages.js";
import diagnosticsRouter from "./routes/diagnostics.js";

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** HTML fallback page when the email-verification link opens in a browser. */
function verifyEmailFallbackHtml(opts: { token: string } | { reason: "no-token" | "invalid" }) {
  if ("reason" in opts) {
    const msg =
      opts.reason === "no-token"
        ? "Open the verification link from your signup email. If you lost the link, request a new one from the app."
        : "This verification link is invalid or has expired. Request a new one from the app and try again.";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verify email</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    p { margin: 0; }
  </style>
</head>
<body>
  <p>${msg}</p>
</body>
</html>`;
  }

  const tokenJson = JSON.stringify(opts.token);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verify email</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; text-align: center; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    #msg { margin-top: 1rem; font-size: 1rem; }
    #msg.error { color: #b91c1c; }
    #msg.ok { color: #15803d; }
    .spinner { display: inline-block; width: 1.25rem; height: 1.25rem; border: 2px solid #ccc; border-top-color: #111; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <h1>Verifying your email</h1>
  <p id="msg"><span class="spinner"></span> One moment...</p>
  <script>
    const TOKEN = ${tokenJson};
    const msg = document.getElementById('msg');
    const LOG = '[email-verify]';
    (async () => {
      const endpoint = '/auth/verify-email';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (parseErr) {
          console.error(LOG, 'response body is not JSON', {
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('content-type'),
            bodyPreview: text.slice(0, 400),
          });
          msg.textContent = 'Unexpected server response. Try again or request a new link.';
          msg.className = 'error';
          return;
        }
        if (!res.ok) {
          const apiMsg = data.error && data.error.message ? data.error.message : 'Something went wrong.';
          console.error(LOG, 'POST failed', { status: res.status, code: data.error && data.error.code, message: apiMsg });
          msg.textContent = apiMsg;
          msg.className = 'error';
          return;
        }
        console.info(LOG, 'email verified', { endpoint, status: res.status });
        msg.textContent = 'Email verified! You can close this page and log in to the app.';
        msg.className = 'ok';
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error(LOG, 'fetch failed', { endpoint, message });
        msg.textContent = 'Network error. Try again.';
        msg.className = 'error';
      }
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML fallback when the reset email link opens in a browser instead of the app. */
function resetPasswordFallbackHtml(
  opts: { email: string; token: string } | { reason: "no-token" | "invalid" },
) {
  if ("reason" in opts) {
    const msg =
      opts.reason === "no-token"
        ? "Open the password reset link from your email. If you lost the link, request a new one from the app."
        : "This reset link is invalid or has expired. Please request a new password reset from the app.";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Password reset</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    p { margin: 0; }
  </style>
</head>
<body>
  <p>${msg}</p>
</body>
</html>`;
  }

  const email = escapeHtml(opts.email);
  const tokenJson = JSON.stringify(opts.token);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Set a new password</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 22rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.35rem; }
    input { width: 100%; padding: 0.5rem 0.65rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; margin-bottom: 1rem; }
    button { width: 100%; padding: 0.6rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .email { margin-bottom: 1.25rem; padding: 0.65rem 0.75rem; background: #f4f4f5; border-radius: 6px; font-size: 0.95rem; word-break: break-all; }
    .hint { font-size: 0.8rem; color: #555; margin-top: -0.5rem; margin-bottom: 1rem; }
    #msg { margin-top: 1rem; font-size: 0.9rem; }
    #msg.error { color: #b91c1c; }
    #msg.ok { color: #15803d; }
  </style>
</head>
<body>
  <h1 style="font-size: 1.25rem; margin-bottom: 0.5rem;">Reset password</h1>
  <p class="hint">Account</p>
  <div class="email">${email}</div>
  <form id="f" novalidate>
    <label for="p1">New password</label>
    <input id="p1" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
    <label for="p2">Confirm password</label>
    <input id="p2" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
    <button type="submit" id="btn">Update password</button>
  </form>
  <p id="msg" role="status"></p>
  <script>
    const TOKEN = ${tokenJson};
    const form = document.getElementById('f');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('btn');
    const LOG = '[password-reset]';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p1 = document.getElementById('p1').value;
      const p2 = document.getElementById('p2').value;
      msg.textContent = '';
      msg.className = '';
      if (p1 !== p2) {
        console.warn(LOG, 'client validation failed', { reason: 'password_mismatch' });
        msg.textContent = 'Passwords do not match.';
        msg.className = 'error';
        return;
      }
      if (p1.length < 8) {
        console.warn(LOG, 'client validation failed', { reason: 'password_too_short', length: p1.length });
        msg.textContent = 'Password must be at least 8 characters.';
        msg.className = 'error';
        return;
      }
      btn.disabled = true;
      const endpoint = '/auth/reset-password';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN, password: p1 }),
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (parseErr) {
          console.error(LOG, 'response body is not JSON', {
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('content-type'),
            bodyPreview: text.slice(0, 400),
          });
          msg.textContent = 'Unexpected server response. Try again or request a new reset link.';
          msg.className = 'error';
          return;
        }
        if (!res.ok) {
          const apiMsg = data.error && data.error.message ? data.error.message : 'Something went wrong.';
          const apiCode = data.error && data.error.code ? data.error.code : undefined;
          const details = data.error && data.error.details ? data.error.details : undefined;
          console.error(LOG, 'POST failed', {
            status: res.status,
            statusText: res.statusText,
            endpoint,
            code: apiCode,
            message: apiMsg,
            details,
          });
          msg.textContent = apiMsg;
          msg.className = 'error';
          return;
        }
        console.info(LOG, 'password updated successfully', { endpoint, status: res.status });
        msg.textContent = 'Password updated. You can close this page and sign in with your new password.';
        msg.className = 'ok';
        form.reset();
      } catch (err) {
        const name = err && err.name ? err.name : 'Error';
        const message = err && err.message ? err.message : String(err);
        console.error(LOG, 'fetch failed', { endpoint, name, message });
        msg.textContent = 'Network error. Try again.';
        msg.className = 'error';
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Build the fully wired Express app — middleware, routes, error handling —
 * without binding a port. src/index.ts listens and owns process lifecycle;
 * integration tests drive the returned app via supertest. validateEnv() (and
 * initSentry, when wanted) must run before this is called.
 */
export function createApp(): express.Express {
  const app = express();

  if (env().NODE_ENV === "production" || env().TRUST_PROXY === "1") {
    app.set("trust proxy", 1);
  }

  // Request ID first so every later middleware (including pino-http) sees req.id.
  app.use(requestIdMiddleware);

  app.use(helmet());
  app.use(
    cors(
      env().NODE_ENV === "production"
        ? { origin: env().CORS_ORIGIN?.split(",") ?? [], credentials: true }
        : { origin: true, credentials: true },
    ),
  );

  // Per-request JSON logger. Replaces morgan and emits one structured line per
  // completed request with status, duration, and the request id.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        const existing = (req as { id?: string }).id;
        return typeof existing === "string" ? existing : crypto.randomUUID();
      },
      redact: { paths: REDACT_PATHS, censor: "[Redacted]", remove: false },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        // Health/readiness probes ping every few seconds — keep them out of info.
        const url = (_req as { url?: string }).url ?? "";
        if (url === "/health" || url === "/ready") return "debug";
        return "info";
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          // Note: deliberately omitting headers + body; redaction covers them
          // but the noise isn't worth it for normal requests.
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(globalLimiter);

  app.get("/health", async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, "Health check failed: DB unreachable");
      res
        .status(503)
        .json({ status: "error", db: "disconnected", timestamp: new Date().toISOString() });
    }
  });

  // Readiness probe — distinct from /health for clarity. Same DB check today;
  // can grow to include downstream services without changing /health's contract.
  app.get("/ready", async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", checks: { db: "ok" } });
    } catch (err) {
      req.log.error({ err }, "Readiness probe failed: DB unreachable");
      res.status(503).json({ status: "not_ready", checks: { db: "error" } });
    }
  });

  app.get("/.well-known/apple-app-site-association", (_req, res) => {
    const appId = getAppleUniversalLinkAppId();
    if (!appId) {
      res.status(404).send("Not found");
      return;
    }
    res.type("application/json").json(buildAppleAppSiteAssociation(appId));
  });

  app.get("/reset-password", async (req, res, next) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
      if (!token) {
        req.log.warn("Password reset: missing or empty token query");
        res.type("html").send(resetPasswordFallbackHtml({ reason: "no-token" }));
        return;
      }

      const hash = hashResetToken(token);
      const user = await prisma.user.findFirst({
        where: {
          resetTokenHash: hash,
          resetTokenExpiry: { gt: new Date() },
        },
        select: { email: true },
      });

      if (!user) {
        req.log.warn(
          { hashPrefix: hash.slice(0, 8) },
          "Password reset: no matching user or token expired",
        );
        res.type("html").send(resetPasswordFallbackHtml({ reason: "invalid" }));
        return;
      }

      req.log.debug("Password reset: serving reset form");
      res.type("html").send(resetPasswordFallbackHtml({ email: user.email, token }));
    } catch (err) {
      req.log.error({ err }, "Password reset: unexpected error rendering form");
      next(err);
    }
  });

  app.get("/verify-email", async (req, res, next) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
      if (!token) {
        req.log.warn("Email verify: missing or empty token query");
        res.type("html").send(verifyEmailFallbackHtml({ reason: "no-token" }));
        return;
      }

      const hash = hashResetToken(token); // sha256 — same helper used for reset tokens
      const user = await prisma.user.findFirst({
        where: {
          emailVerificationTokenHash: hash,
          emailVerificationExpiry: { gt: new Date() },
        },
        select: { id: true },
      });

      if (!user) {
        req.log.warn(
          { hashPrefix: hash.slice(0, 8) },
          "Email verify: no matching user or token expired",
        );
        res.type("html").send(verifyEmailFallbackHtml({ reason: "invalid" }));
        return;
      }

      req.log.debug("Email verify: serving auto-submit page");
      res.type("html").send(verifyEmailFallbackHtml({ token }));
    } catch (err) {
      req.log.error({ err }, "Email verify: unexpected error rendering page");
      next(err);
    }
  });

  // Every API router is mounted twice: the bare paths are the frozen contract
  // for shipped iOS builds; /v1 is the canonical prefix going forward. New app
  // releases point at /v1, and a future breaking change ships as /v2 without
  // touching the bare mounts. Root-level endpoints (/health, /ready, AASA, the
  // reset/verify HTML pages) stay unversioned.
  const apiRouters = [
    ["/auth", authRouter],
    ["/users", usersRouter],
    ["/items", itemsRouter],
    ["/brands", brandsRouter],
    ["/swipes", swipesRouter],
    ["/collections", collectionsRouter],
    ["/social", socialRouter],
    ["/messages", messagesRouter],
    ["/diagnostics", diagnosticsRouter],
  ] as const;
  for (const [path, router] of apiRouters) {
    app.use(`/v1${path}`, router);
    app.use(path, router);
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  // Sentry's error handler captures 5xx (and only 5xx, per attachSentryErrorHandler's
  // filter) and forwards to our custom errorHandler for the actual response shape.
  // Must be placed after routes and before errorHandler.
  attachSentryErrorHandler(app);
  app.use(errorHandler);

  return app;
}
