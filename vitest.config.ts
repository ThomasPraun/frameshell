import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Installs the pinned ffmpeg once for media tests (tens of MB), kept under .cache/.
    globalSetup: ["./vitest.global-setup.ts"],
    // Tests spawn processes and bind sockets; Windows CI is slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
