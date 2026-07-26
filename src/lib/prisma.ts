import "dotenv/config";
import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (typeof connectionString !== "string" || connectionString.length === 0) {
  throw new Error("DATABASE_URL is missing or invalid. Check your .env file.");
}

const pool = new Pool({
  connectionString,
  // Keep foreground API capacity bounded. Expensive catalog routes have
  // process-local admission control, leaving spare connections for auth,
  // social writes, and readiness.
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "clothedd-api",
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

const configuredReadinessMaxLatency = Number(process.env.DB_READY_MAX_LATENCY_MS);
const readinessMaxLatencyMs =
  Number.isFinite(configuredReadinessMaxLatency) && configuredReadinessMaxLatency > 0
    ? Math.floor(configuredReadinessMaxLatency)
    : 2_500;

export type DbReadiness = {
  ok: boolean;
  latencyMs: number;
  pool: { total: number; idle: number; waiting: number };
  reason?: string;
};

let readinessCache: { value: DbReadiness; expiresAt: number } | null = null;
let readinessInflight: Promise<DbReadiness> | null = null;

/**
 * Single-flight representative catalog probe. SET LOCAL bounds SQL execution;
 * the pool connection timeout bounds checkout. A short cache prevents Railway
 * probes from becoming load themselves during an incident.
 */
export async function checkDbReadiness(): Promise<DbReadiness> {
  const now = Date.now();
  if (readinessCache && readinessCache.expiresAt > now) return readinessCache.value;
  if (readinessInflight) return readinessInflight;

  readinessInflight = (async () => {
    const startedAt = Date.now();
    const stats = () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });

    if (pool.waitingCount >= 2 && pool.idleCount === 0) {
      return {
        ok: false,
        latencyMs: 0,
        pool: stats(),
        reason: "api_pool_saturated",
      };
    }

    let client: PoolClient | undefined;
    let inTransaction = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '1500ms'");
      await client.query(`
        SELECT id
        FROM "ClothingItem"
        WHERE active = true AND "hasPerson" IS NOT TRUE
        ORDER BY "createdAt" DESC
        LIMIT 1
      `);
      await client.query("ROLLBACK");
      inTransaction = false;
      const latencyMs = Date.now() - startedAt;
      return {
        ok: latencyMs <= readinessMaxLatencyMs,
        latencyMs,
        pool: stats(),
        ...(latencyMs > readinessMaxLatencyMs ? { reason: "catalog_probe_slow" } : {}),
      };
    } catch (_err) {
      if (client && inTransaction) await client.query("ROLLBACK").catch(() => undefined);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        pool: stats(),
        // `/ready` is public. Keep failure detail out of the response; the
        // latency and pool counters are enough for the worker governor.
        reason: "catalog_probe_failed",
      };
    } finally {
      client?.release();
    }
  })();

  try {
    const value = await readinessInflight;
    readinessCache = { value, expiresAt: Date.now() + 5_000 };
    return value;
  } finally {
    readinessInflight = null;
  }
}
