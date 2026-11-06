import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/buildCli.ts"],
    testTimeout: 30_000,
  },
});
