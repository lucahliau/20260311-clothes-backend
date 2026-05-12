import { prisma } from "./prisma.js";
import { sendPushToUser } from "./apns.js";
import { isBlockedPair } from "./social.js";

/**
 * Send a social-event push to `userId`.
 *
 * When `actorId` is provided, this also acts as a defense-in-depth block
 * gate: if either side has blocked the other, the push is silently dropped.
 * The caller's own block check (e.g. before creating a follow) remains the
 * primary gate; this is a backstop so a future code path can't accidentally
 * notify a blocked user.
 */
export async function notifySocialEvent(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
  actorId?: string,
): Promise<void> {
  if (actorId && actorId !== userId && (await isBlockedPair(actorId, userId))) {
    return;
  }
  try {
    await sendPushToUser(
      userId,
      {
        alert: { title: payload.title, body: payload.body },
        data: payload.data,
      },
      prisma
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[social] push skipped:", msg);
  }
}
