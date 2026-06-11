import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { logger } from "./logger.js";

const AVATAR_BUCKET = "avatars";
/** Supabase signed upload URLs are valid for 2 hours. */
const SIGNED_UPLOAD_TTL_SECONDS = 7200;

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = env();
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error("Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY");
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return _client;
}

/** Public-read base URL of the avatars bucket, or null when Supabase is unconfigured. */
export function avatarPublicPrefix(): string | null {
  const { SUPABASE_URL } = env();
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${AVATAR_BUCKET}/`;
}

/** Bucket-relative path for one of our public avatar URLs, or null if it isn't one. */
export function avatarPathFromPublicUrl(url: string): string | null {
  const prefix = avatarPublicPrefix();
  if (!prefix || !url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length);
  return path.length > 0 ? decodeURIComponent(path) : null;
}

/** Best-effort delete of a replaced/orphaned avatar object. Never throws. */
export async function removeAvatarObject(path: string): Promise<void> {
  try {
    const { error } = await getClient().storage.from(AVATAR_BUCKET).remove([path]);
    if (error) {
      logger.warn({ path, error: error.message }, "[supabase] avatar cleanup failed");
    }
  } catch (err) {
    logger.warn({ path, err }, "[supabase] avatar cleanup failed");
  }
}

export async function createAvatarUploadUrl(
  userId: string,
  fileExt: string = "jpg",
): Promise<{ signedUrl: string; publicUrl: string; path: string; expiresIn: number }> {
  const client = getClient();
  const path = `${userId}/avatar-${Date.now()}.${fileExt}`;

  const { data, error } = await client.storage.from(AVATAR_BUCKET).createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(`Failed to create upload URL: ${error?.message ?? "unknown error"}`);
  }

  const { data: urlData } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);

  return {
    signedUrl: data.signedUrl,
    publicUrl: urlData.publicUrl,
    path,
    expiresIn: SIGNED_UPLOAD_TTL_SECONDS,
  };
}
