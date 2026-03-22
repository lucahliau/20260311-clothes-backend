import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

const AVATAR_BUCKET = "avatars";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = env();
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      // #region agent log
      fetch("http://127.0.0.1:7507/ingest/3a77d871-a128-4a3c-967a-b57c3dd36fae", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "62b7aa" },
        body: JSON.stringify({
          sessionId: "62b7aa",
          location: "src/lib/supabase.ts:getClient",
          message: "Supabase env check failed",
          data: {
            H1_urlMissing: !SUPABASE_URL,
            H2_keyMissing: !SUPABASE_SERVICE_KEY,
            urlLen: SUPABASE_URL?.length ?? 0,
            keyLen: SUPABASE_SERVICE_KEY?.length ?? 0,
            H3_altServiceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
            H4_nodeEnv: process.env.NODE_ENV,
          },
          timestamp: Date.now(),
          hypothesisId: "H1-H4",
        }),
      }).catch(() => {});
      // #endregion
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
