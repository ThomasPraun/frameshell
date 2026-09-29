import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Tests spawn processes and bind sockets; Windows CI is slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
