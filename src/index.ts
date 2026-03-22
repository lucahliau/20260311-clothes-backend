import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

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

app.get("/reset-password", (req, res) => {
  const hasToken = typeof req.query.token === "string" && req.query.token.length > 0;
  const bodyText = hasToken
    ? "Continue in the Clothes app to choose a new password. If this page opened in Safari, use the same link on the device where the app is installed."
    : "Open the password reset link from your email on your phone to continue in the app.";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Password reset</title>
</head>
<body>
  <p>${bodyText}</p>
</body>
</html>`;
  res.type("html").send(html);
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
