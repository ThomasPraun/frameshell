import { defineConfig } from "@playwright/test";

// Drives the built Electron app (`electron-vite build` first; `pnpm test:e2e` does both).
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  outputDir: "test-results",
});
