import { describe, it, expect } from "vitest";
import {
  isLockedOut,
  nextStateOnFailure,
  shouldClearOnSuccess,
  MAX_FAILED_LOGIN_ATTEMPTS,
  LOGIN_LOCK_DURATION_MS,
} from "./loginLockout.js";

const now = new Date("2026-05-12T12:00:00Z");

describe("isLockedOut", () => {
  it("is false when lockedUntil is null", () => {
    expect(isLockedOut({ failedLoginAttempts: 0, lockedUntil: null }, now)).toBe(false);
  });

  it("is false when the lock window has expired", () => {
    expect(
      isLockedOut({ failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() - 1) }, now),
    ).toBe(false);
  });

  it("is true while the lock window is still in the future", () => {
    expect(
      isLockedOut({ failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + 1000) }, now),
    ).toBe(true);
  });
});

describe("nextStateOnFailure", () => {
  it("increments the counter without locking before the threshold", () => {
    const next = nextStateOnFailure(
      { failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS - 2, lockedUntil: null },
      now,
    );
    expect(next.failedLoginAttempts).toBe(MAX_FAILED_LOGIN_ATTEMPTS - 1);
    expect(next.lockedUntil).toBe(null);
  });

  it("locks the account on the failure that hits the threshold", () => {
    const next = nextStateOnFailure(
      { failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS - 1, lockedUntil: null },
      now,
    );
    expect(next.failedLoginAttempts).toBe(0);
    expect(next.lockedUntil?.getTime()).toBe(now.getTime() + LOGIN_LOCK_DURATION_MS);
  });

  it("preserves the existing lock when failing again past the threshold", () => {
    // This branch is mostly unreachable in practice (we short-circuit on
    // isLockedOut earlier), but we should never lose the lock if it ever ran.
    const existingLock = new Date(now.getTime() + 5_000);
    const next = nextStateOnFailure(
      { failedLoginAttempts: 0, lockedUntil: existingLock },
      now,
    );
    expect(next.lockedUntil).toBe(existingLock);
  });
});

describe("shouldClearOnSuccess", () => {
  it("returns false on a clean account", () => {
    expect(shouldClearOnSuccess({ failedLoginAttempts: 0, lockedUntil: null })).toBe(false);
  });

  it("returns true when the counter is non-zero", () => {
    expect(shouldClearOnSuccess({ failedLoginAttempts: 1, lockedUntil: null })).toBe(true);
  });

  it("returns true when a stale lock is set (even if expired)", () => {
    expect(
      shouldClearOnSuccess({ failedLoginAttempts: 0, lockedUntil: new Date(0) }),
    ).toBe(true);
  });
});
