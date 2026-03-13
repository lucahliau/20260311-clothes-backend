import http2 from "node:http2";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import { env } from "./env.js";

const APNS_HOST_PROD = "https://api.push.apple.com";
const APNS_HOST_DEV = "https://api.sandbox.push.apple.com";
const TOKEN_TTL_MS = 55 * 60 * 1000; // refresh JWT every 55 min (Apple max is 60)

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

export async function sendPushNotification(
  deviceToken: string,
  payload: PushPayload
): Promise<{ success: boolean; statusCode: number }> {
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

  return new Promise((resolve, reject) => {
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
        resolve({ success: statusCode === 200, statusCode });
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

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  prisma: { deviceToken: { findMany: (args: { where: { userId: string } }) => Promise<{ token: string }[]> } }
): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({ where: { userId } });

  const results = await Promise.allSettled(
    tokens.map((t) => sendPushNotification(t.token, payload))
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[APNs] Push failed:", r.reason);
    }
  }
}
