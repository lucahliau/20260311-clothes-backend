import { execSync } from "node:child_process";

/**
 * Runs once before the suite (in its own process): validates the target DB is
 * an explicit, local test database, then applies migrations to it.
 *
 * The suite TRUNCATES tables — it must never point at a real database, so it
 * only accepts TEST_DATABASE_URL (never DATABASE_URL) and only on localhost.
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests.\n" +
        "Start a throwaway pgvector Postgres (see README) and re-run, e.g.\n" +
        "  TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/clothes_test npm run test:integration",
    );
  }

  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(
      `Refusing to run integration tests against non-local host "${host}" — the suite truncates tables.`,
    );
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
