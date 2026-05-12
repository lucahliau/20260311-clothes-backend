import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { setSentryUser } from "../lib/sentry.js";

export interface AuthPayload {
  userId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Bind the authenticated userId to the request-scoped logger and Sentry
 * scope so every subsequent log line / captured exception carries it.
 */
function bindAuthContext(req: Request, payload: AuthPayload): void {
  if (req.log) {
    req.log = req.log.child({ userId: payload.userId });
  }
  setSentryUser(req, payload.userId);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    req.user = payload;
    bindAuthContext(req, payload);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Sets `req.user` when a valid Bearer token is present; otherwise continues without auth. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next();
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    req.user = payload;
    bindAuthContext(req, payload);
  } catch {
    // no user
  }
  next();
}
