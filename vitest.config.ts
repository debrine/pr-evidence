import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/buildCli.ts"],
    setupFiles: ["tests/support/skipPendingOnWindows.ts"],
    testTimeout: 30_000,
    // The first fake registry packs the helper and its dependencies, which is slow on Windows.
    hookTimeout: 30_000,
  },
});
