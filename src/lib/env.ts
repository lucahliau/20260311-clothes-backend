import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /** Set to "1" to trust the reverse proxy outside production (Railway is covered by NODE_ENV). */
  TRUST_PROXY: z.string().optional(),
  /** Comma-separated browser origins allowed by CORS in production. */
  CORS_ORIGIN: z.string().optional(),

  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),

  RESEND_API_KEY: z.string().optional(),
  /** Sender for transactional email; must be allowed in Resend (e.g. onboarding@resend.dev or your verified domain). */
  RESEND_FROM_EMAIL: z.string().email().default("onboarding@resend.dev"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  /** Must match the iOS bundle ID or Sign in with Apple Services ID string (the token `aud` claim). */
  APPLE_CLIENT_ID: z.string().optional(),

  /** OAuth client ID whose ID tokens the app sends; must match the token `aud` (often the iOS client ID). */
  GOOGLE_CLIENT_ID: z.string().optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),

  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_KEY_PATH: z.string().optional(),

  /** Full `TeamID.bundleIdentifier` for Universal Links (AASA). Overrides APNS_TEAM_ID + APNS_BUNDLE_ID when set. */
  APPLE_UNIVERSAL_LINK_APP_ID: z.string().optional(),

  R2_PUBLIC_URL: z.string().url().optional(),

  /** Custom domain on the R2 bucket with Cloudflare Image Transformations enabled
   * (e.g. img.clothedd.com). When set, item image URLs are rewritten to resized,
   * edge-cached /cdn-cgi/image/ variants. Unset = serve stored URLs as-is. */
  IMG_CDN_HOST: z.string().optional(),

  // Observability — all optional. When SENTRY_DSN is unset Sentry is a no-op.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  /** Self-hosted logdeck hub (central log collation across projects, ~/Desktop/logdeck).
   * Both optional — the pino mirror in logger.ts is a no-op when either is unset.
   * LOGDECK_KEY is this project's write-only ingest key (ldk_…), not the hub admin key. */
  LOGDECK_URL: z.string().url().optional(),
  LOGDECK_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\nMissing or invalid environment variables:\n${formatted}\n`);
    process.exit(1);
  }

  _env = result.data;
  return _env;
}

export function env(): Env {
  if (!_env) {
    throw new Error("env() called before validateEnv() — call validateEnv() at startup");
  }
  return _env;
}

/** `TeamID.bundleId` for apple-app-site-association, or null if Universal Links are not configured. */
export function getAppleUniversalLinkAppId(): string | null {
  const e = env();
  const explicit = e.APPLE_UNIVERSAL_LINK_APP_ID?.trim();
  if (explicit) return explicit;
  if (e.APNS_TEAM_ID && e.APNS_BUNDLE_ID) {
    return `${e.APNS_TEAM_ID}.${e.APNS_BUNDLE_ID}`;
  }
  return null;
}
