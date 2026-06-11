import { z } from "zod";

/**
 * Normalize common client drift before Zod validation:
 * - Nested `{ user: { email, password } }` or `{ credentials: { ... } }`
 * - `username` that looks like an email (treated as `email`)
 */
export function normalizeLoginBody(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.email === "string") {
    return raw;
  }

  if (o.user && typeof o.user === "object" && !Array.isArray(o.user)) {
    const u = o.user as Record<string, unknown>;
    return { email: u.email, password: u.password };
  }

  if (o.credentials && typeof o.credentials === "object" && !Array.isArray(o.credentials)) {
    const c = o.credentials as Record<string, unknown>;
    return { email: c.email, password: c.password };
  }

  if (typeof o.username === "string" && o.username.includes("@")) {
    return { ...o, email: o.username };
  }

  return raw;
}

/** Login accepts either identifier: a valid email, or a plain username. */
const loginFieldsSchema = z
  .object({
    email: z.string().email().optional(),
    username: z.string().min(1).optional(),
    password: z.string(),
  })
  .refine((v) => Boolean(v.email ?? v.username), {
    message: "email or username is required",
  });

/** Parsed login payload after normalization + validation. */
export const loginBodySchema = z.preprocess(normalizeLoginBody, loginFieldsSchema);
