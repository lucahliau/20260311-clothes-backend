import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

const AVATAR_BUCKET = "avatars";

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

export async function createAvatarUploadUrl(
  userId: string,
  fileExt: string = "jpg"
): Promise<{ signedUrl: string; publicUrl: string; path: string }> {
  const client = getClient();
  const path = `${userId}/avatar-${Date.now()}.${fileExt}`;

  const { data, error } = await client.storage
    .from(AVATAR_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(`Failed to create upload URL: ${error?.message ?? "unknown error"}`);
  }

  const { data: urlData } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);

  return {
    signedUrl: data.signedUrl,
    publicUrl: urlData.publicUrl,
    path,
  };
}
