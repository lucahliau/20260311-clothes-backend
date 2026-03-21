import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

import { validateEnv, env } from "./lib/env.js";
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

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/items", itemsRouter);
app.use("/brands", brandsRouter);
app.use("/swipes", swipesRouter);
app.use("/collections", collectionsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use(errorHandler);

const PORT = env().PORT;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
