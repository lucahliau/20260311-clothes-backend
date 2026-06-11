/**
 * Canonical form for stored and queried emails: trimmed + lowercased.
 * Applied on every auth write and lookup; the `lower(email)` unique index
 * (migration 20260610000000) is the database-level backstop.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
