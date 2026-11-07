import { defineConfig } from "vitest/config";

// Opt-in: performs one real upload, which GitHub offers no supported way to delete.
export default defineConfig({
  test: {
    include: ["tests/smoke/upload.smoke.ts"],
    globalSetup: ["tests/support/buildCli.ts"],
    testTimeout: 60_000,
  },
});
