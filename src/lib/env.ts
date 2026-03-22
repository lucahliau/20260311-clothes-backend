import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),

  RESEND_API_KEY: z.string().optional(),
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
