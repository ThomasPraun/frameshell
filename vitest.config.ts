import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Installs the pinned ffmpeg once for media tests (tens of MB), kept under .cache/.
    globalSetup: ["./vitest.global-setup.ts"],
    // The CLI names an agent among its parent processes (ADR 0025): tests run from an agent's shell must not be one.
    env: {
      FRAMESHELL_AGENT_COMMANDS: "claude=,codex=,gemini=,aider=,opencode=,amp=,goose=,cursor-agent=,qwen=,copilot=,crush=,pi=",
    },
    // Tests spawn processes and bind sockets; Windows CI is slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
