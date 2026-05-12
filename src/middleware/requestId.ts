/**
 * Request ID middleware.
 *
 * Generates a UUID v4 per request, exposes it on `req.id`, and echoes it back
 * via the `x-request-id` response header so the iOS client can include it in
 * bug reports. If an upstream proxy already set `x-request-id`, we honor it,
 * but only when it parses as a UUID — otherwise an attacker-controlled value
 * could be used to inject log lines or break correlation downstream.
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure resolver: returns the inbound header value when it's a valid UUID,
 * otherwise a fresh UUID v4. Exposed so the validation branch can be
 * unit-tested without spinning up Express.
 */
export function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === "string" && UUID_RE.test(headerValue)) {
    return headerValue;
  }
  return crypto.randomUUID();
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers["x-request-id"]);
  req.id = id;
  res.setHeader("x-request-id", id);
  next();
}
