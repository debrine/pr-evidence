import { defineConfig } from "vitest/config";

// Real Chrome through real chrome-devtools-axi. Runs as the Windows smoke job, and locally on any OS.
export default defineConfig({
  test: {
    include: ["tests/smoke/windowsBrowser.smoke.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
