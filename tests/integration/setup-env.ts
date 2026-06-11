import { afterAll, vi } from "vitest";

// Must run before any src/ module loads: src/lib/prisma.ts reads DATABASE_URL
// at import time, and src/lib/env.ts snapshots process.env in validateEnv().
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is required (global-setup should have failed already)");
}

process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "integration-test-jwt-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "integration-test-refresh-secret-0123456789";
process.env.APP_URL ??= "http://localhost:3000";
// Resend client refuses to construct without a key; sends themselves are mocked below.
process.env.RESEND_API_KEY ??= "re_integration_test_dummy";

// Outbound email would hit the real Resend API with the dummy key and fail the
// request. Tests only need the send calls to succeed. NOTE: vi.mock replaces
// the WHOLE module — every exported sender must be stubbed here, or routes
// that call a missing one will 500 with "undefined is not a function".
vi.mock("../../src/lib/email.js", () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
  sendPasswordChangedEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
  sendSignInMethodAddedEmail: vi.fn(async () => {}),
  sendAccountDeletedEmail: vi.fn(async () => {}),
  renderEmail: vi.fn(() => "<html></html>"),
}));

const { validateEnv } = await import("../../src/lib/env.js");
validateEnv();

afterAll(async () => {
  const { prisma } = await import("../../src/lib/prisma.js");
  await prisma.$disconnect();
});
