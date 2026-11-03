import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Connect Claude Code (#430, ADR 0025 decision 7): the agent guide offers it where Claude Code's settings exist.
// The connect dialog is a native message box and the file edits are unit-tested (packages/cli claude-code-setup),
// so this pins that the link follows the settings folder of the (sandboxed) home.
const box = sandbox("demo");

test.skip(process.platform === "win32", "HOME is not the home folder on Windows");

test("the agent guide offers Connect Claude Code only when Claude Code's settings exist", async () => {
  const home = join(box.dataDir, "home-with-claude");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const withClaude = await launch(box, { env: { HOME: home, CLAUDE_CONFIG_DIR: "" } });
  try {
    await expect(withClaude.page.getByTestId("agent-guide").getByRole("button", { name: "Connect Claude Code" })).toBeVisible();
  } finally {
    await withClaude.app.close();
  }

  const empty = join(box.dataDir, "home-empty");
  mkdirSync(empty, { recursive: true });
  const without = await launch(box, { env: { HOME: empty, CLAUDE_CONFIG_DIR: "" } });
  try {
    const guide = without.page.getByTestId("agent-guide");
    await expect(guide.getByRole("heading", { name: "Talk to an agent" })).toBeVisible();
    await expect(guide.getByRole("button", { name: "Connect Claude Code" })).toHaveCount(0);
  } finally {
    await without.app.close();
  }
});
