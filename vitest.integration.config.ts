import { defineConfig } from "vitest/config";

// Endpoint tests against a real Postgres (pgvector required by migrations).
// Files run sequentially — they share one database and truncate between files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
