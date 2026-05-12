import http2 from "node:http2";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

const APNS_HOST_PROD = "https://api.push.apple.com";
const APNS_HOST_DEV = "https://api.sandbox.push.apple.com";
const TOKEN_TTL_MS = 55 * 60 * 1000; // refresh JWT every 55 min (Apple max is 60)

/** Delete a device token after this many consecutive transient failures. */
const MAX_CONSECUTIVE_FAILURES = 10;

let cachedToken: { jwt: string; createdAt: number } | null = null;

function getApnsJwt(): string {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH } = env();

  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_KEY_PATH) {
    throw new Error("APNs is not configured — set APNS_KEY_ID, APNS_TEAM_ID, and APNS_KEY_PATH");
  }

  if (cachedToken && Date.now() - cachedToken.createdAt < TOKEN_TTL_MS) {
    return cachedToken.jwt;
  }

  const key = fs.readFileSync(APNS_KEY_PATH, "utf8");
  const token = jwt.sign({}, key, {
    algorithm: "ES256",
    keyid: APNS_KEY_ID,
    issuer: APNS_TEAM_ID,
    expiresIn: "1h",
  });

  cachedToken = { jwt: token, createdAt: Date.now() };
  return token;
}

export interface PushPayload {
  alert?: { title: string; body: string };
  badge?: number;
  sound?: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  statusCode: number;
  /** APNS error reason from the response body (e.g. "Unregistered"), if any. */
  reason: string | null;
}

export type ApnsAction = "ok" | "delete" | "retry" | "suppress";

/**
 * Classify an APNS response so token cleanup decisions are isolated from I/O.
 *
 * - `ok`       — push delivered.
 * - `delete`   — token is permanently invalid; drop the row.
 * - `retry`    — transient APNS issue; bump failureCount, prune after threshold.
 * - `suppress` — our config or payload is wrong; log loudly, leave token alone.
 *
 * Reference: Apple Developer "Handling Notification Responses from APNs".
 */
export function classifyApnsResponse(status: number, reason: string | null): ApnsAction {
  if (status === 200) return "ok";

  // 410 always means the token is no longer valid (Apple always sends
  // reason="Unregistered" here, but we don't gate on it in case of variants).
  if (status === 410) return "delete";

  if (status === 400) {
    // Only treat *token*-level 400s as fatal. Topic/payload/env 400s are our
    // bug — deleting the user's token would mask the real problem.
    if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
      return "delete";
    }
    return "suppress";
  }

  // 403 = auth (our JWT/key); 5xx + 429 = transient. Both retriable.
  if (status === 403 || status === 429 || (status >= 500 && status < 600)) {
    return "retry";
  }

  return "suppress";
}

export async function sendPushNotification(
  deviceToken: string,
  payload: PushPayload,
): Promise<SendResult> {
  const { APNS_BUNDLE_ID } = env();
  if (!APNS_BUNDLE_ID) {
    throw new Error("APNs is not configured — set APNS_BUNDLE_ID");
  }

  const host = env().NODE_ENV === "production" ? APNS_HOST_PROD : APNS_HOST_DEV;
  const token = getApnsJwt();

  const apnsPayload = {
    aps: {
      ...(payload.alert && { alert: payload.alert }),
      ...(payload.badge !== undefined && { badge: payload.badge }),
      sound: payload.sound || "default",
    },
    ...payload.data,
  };

  return new Promise<SendResult>((resolve, reject) => {
    const client = http2.connect(host);
    client.on("error", reject);

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });

    let data = "";
    req.on("response", (headers) => {
      const statusCode = Number(headers[":status"]);
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        client.close();
        let reason: string | null = null;
        if (statusCode !== 200 && data.length > 0) {
          try {
            const parsed = JSON.parse(data) as { reason?: unknown };
            if (typeof parsed.reason === "string") reason = parsed.reason;
          } catch {
            // Non-JSON body; leave reason null.
          }
        }
        resolve({ success: statusCode === 200, statusCode, reason });
      });
    });

    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.write(JSON.stringify(apnsPayload));
    req.end();
  });
}

async function applyDelete(token: string): Promise<void> {
  await prisma.deviceToken.deleteMany({ where: { token } });
}

async function applyOk(token: string): Promise<void> {
  await prisma.deviceToken.updateMany({
    where: { token },
    data: { lastSuccessAt: new Date(), failureCount: 0 },
  });
}

async function applyRetry(token: string): Promise<void> {
  // Bump failure count; prune if we've hit the threshold. Two-step because
  // Prisma can't conditionally update-or-delete in a single call without
  // raw SQL — and the contention here is negligible.
  const row = await prisma.deviceToken.findUnique({
    where: { token },
    select: { failureCount: true },
  });
  if (!row) return;
  const next = row.failureCount + 1;
  if (next >= MAX_CONSECUTIVE_FAILURES) {
    await prisma.deviceToken.deleteMany({ where: { token } });
    return;
  }
  await prisma.deviceToken.updateMany({
    where: { token },
    data: { failureCount: next, lastFailureAt: new Date() },
  });
}

/**
 * Send `payload` to every device token owned by `userId`, in parallel.
 *
 * Acts on the response from each token: deletes permanently-invalid tokens,
 * tracks transient failures, updates lastSuccessAt on delivery. Cleanup
 * writes are best-effort — if a write throws, the push has still succeeded
 * for the caller's purposes.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
  });

  const results = await Promise.allSettled(
    tokens.map(async (t) => {
      const result = await sendPushNotification(t.token, payload);
      return { token: t.token, result };
    }),
  );

  await Promise.allSettled(
    results.map(async (r) => {
      try {
        if (r.status === "rejected") {
          // Network/HTTP/2 error before we got an APNS response. Treat as transient.
          logger.warn({ err: r.reason }, "[APNs] Push transport error");
          return;
        }
        const { token, result } = r.value;
        const action = classifyApnsResponse(result.statusCode, result.reason);
        if (action === "ok") {
          await applyOk(token);
        } else if (action === "delete") {
          await applyDelete(token);
        } else if (action === "retry") {
          await applyRetry(token);
        } else {
          // suppress: our config/payload bug — surface it, but don't touch the token.
          logger.warn(
            { status: result.statusCode, reason: result.reason },
            "[APNs] Suppressed push failure (config/payload)",
          );
        }
      } catch (err) {
        logger.warn({ err }, "[APNs] Token-health write failed");
      }
    }),
  );
}
