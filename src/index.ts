import dotenv from "dotenv";

dotenv.config();

import { validateEnv, env } from "./lib/env.js";
validateEnv();

import { logger } from "./lib/logger.js";
import { initSentry, captureException, flushSentry } from "./lib/sentry.js";

// Sentry must initialize before the Express app is built so its instrumentation
// can wrap incoming requests. A missing DSN turns this into a no-op.
initSentry({
  dsn: env().SENTRY_DSN,
  environment: env().SENTRY_ENVIRONMENT ?? env().NODE_ENV,
  tracesSampleRate: env().SENTRY_TRACES_SAMPLE_RATE,
});

import { prisma } from "./lib/prisma.js";
import { createApp } from "./app.js";

const app = createApp();

const PORT = env().PORT;
const server = app.listen(PORT, () => {
  const e = env();
  logger.info({ port: PORT, appUrl: e.APP_URL, env: e.NODE_ENV }, "Server listening");
});

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

// Railway SIGTERMs the old container on every deploy. Without a handler Node
// dies by signal (exit 143) and the deployment is recorded as crashed. Drain
// HTTP, release the DB pool, exit 0 — under a hard deadline because open
// keep-alive sockets can stall server.close() indefinitely.
const SHUTDOWN_DEADLINE_MS = 5_000;
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  server.close(() => {
    prisma
      .$disconnect()
      .catch((err: unknown) => logger.error({ err }, "Prisma disconnect failed during shutdown"))
      .finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Surface errors that escape the request pipeline (timers, background pushes,
// fire-and-forget promises). Rejections are logged and reported but don't kill
// the process; a truly uncaught exception exits 1 so Railway restarts us clean.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  captureException(reason);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  captureException(err);
  void flushSentry(2_000).finally(() => process.exit(1));
});
