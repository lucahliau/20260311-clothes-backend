import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

import { validateEnv, env, getAppleUniversalLinkAppId } from "./lib/env.js";
import { buildAppleAppSiteAssociation } from "./lib/appleAppSiteAssociation.js";
validateEnv();

import { prisma } from "./lib/prisma.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/error.js";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import itemsRouter from "./routes/items.js";
import brandsRouter from "./routes/brands.js";
import swipesRouter from "./routes/swipes.js";
import collectionsRouter from "./routes/collections.js";
import socialRouter from "./routes/social.js";
import messagesRouter from "./routes/messages.js";

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML fallback when the reset email link opens in a browser instead of the app. */
function resetPasswordFallbackHtml(opts: { email: string; token: string } | { reason: "no-token" | "invalid" }) {
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

const app = express();

if (env().NODE_ENV === "production" || process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(
  cors(
    env().NODE_ENV === "production"
      ? { origin: process.env.CORS_ORIGIN?.split(",") ?? [], credentials: true }
      : { origin: true, credentials: true }
  )
);
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(globalLimiter);

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected", timestamp: new Date().toISOString() });
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
  const logPrefix = "[password-reset] GET /reset-password";
  try {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      console.warn(`${logPrefix}: missing or empty token query`);
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
      console.warn(`${logPrefix}: no matching user or token expired (hash prefix ${hash.slice(0, 8)}…)`);
      res.type("html").send(resetPasswordFallbackHtml({ reason: "invalid" }));
      return;
    }

    if (env().NODE_ENV !== "production") {
      console.debug(`${logPrefix}: serving reset form`, { email: user.email });
    }
    res.type("html").send(resetPasswordFallbackHtml({ email: user.email, token }));
  } catch (err) {
    console.error(`${logPrefix}: unexpected error`, err);
    next(err);
  }
});

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/items", itemsRouter);
app.use("/brands", brandsRouter);
app.use("/swipes", swipesRouter);
app.use("/collections", collectionsRouter);
app.use("/social", socialRouter);
app.use("/messages", messagesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use(errorHandler);

const PORT = env().PORT;
app.listen(PORT, () => {
  const e = env();
  console.log(
    `Server listening on port ${PORT} | APP_URL=${e.APP_URL} (use this origin for clients and password-reset links)`
  );
});
