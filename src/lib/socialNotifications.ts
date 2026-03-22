import { prisma } from "./prisma.js";
import { sendPushToUser } from "./apns.js";

export async function notifySocialEvent(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown> }
): Promise<void> {
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
