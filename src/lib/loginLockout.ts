/**
 * Per-account login lockout policy.
 *
 * The IP-based authLimiter alone is bypassed by a credential-stuffer who
 * rotates IPs; a counter on the user row + a temporary lock closes that
 * surface without needing distributed state.
 *
 * The decision logic is pulled out of the route handler so it's straightforward
 * to unit-test the threshold/reset edges without standing up the full Express
 * + Prisma stack.
 */

export const MAX_FAILED_LOGIN_ATTEMPTS = 10;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export interface LockoutState {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/** True if the account is currently in a lockout window. */
export function isLockedOut(state: LockoutState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && state.lockedUntil > now;
}

export interface NextFailureState {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Compute the next persisted state after a failed bcrypt compare. Once the
 * threshold is reached, we set a lock and reset the counter so the *next*
 * failure after the lock expires starts fresh.
 */
export function nextStateOnFailure(
  state: LockoutState,
  now: Date = new Date(),
): NextFailureState {
  const nextAttempts = state.failedLoginAttempts + 1;
  if (nextAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
    return {
      failedLoginAttempts: 0,
      lockedUntil: new Date(now.getTime() + LOGIN_LOCK_DURATION_MS),
    };
  }
  return { failedLoginAttempts: nextAttempts, lockedUntil: state.lockedUntil };
}

/** True when a successful login needs to clear leftover counter/lock state. */
export function shouldClearOnSuccess(state: LockoutState): boolean {
  return state.failedLoginAttempts > 0 || state.lockedUntil !== null;
}
