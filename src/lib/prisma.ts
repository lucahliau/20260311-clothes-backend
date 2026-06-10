import "dotenv/config";
import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (typeof connectionString !== "string" || connectionString.length === 0) {
  throw new Error("DATABASE_URL is missing or invalid. Check your .env file.");
}

const pool = new Pool({
  connectionString,
  // Supabase pooler (pgbouncer, port 6543): keep our share of the shared DB
  // modest, and allow for its slow cold connects (~8s observed).
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
