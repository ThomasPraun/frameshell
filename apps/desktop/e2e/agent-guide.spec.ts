import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox, terminalText } from "./harness.js";

// Agent guide (#190): the agents found get Start, which runs the one found in the terminal; with it running, a
// suggestion lands at its prompt unsent. The stand-in agent (fake-agent.mjs) is installed as `gemini` on PATH, and
// FRAMESHELL_AGENT_COMMANDS labels its node process as that agent.
const box = sandbox("demo");
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");

test.skip(process.platform === "win32", "the stand-in agent is a POSIX shell script; detection needs ps");

test("Start runs a found agent, and a suggestion is typed at its prompt unsent", async () => {
  const bin = join(box.dataDir, "agents-bin");
  mkdirSync(bin, { recursive: true });
  const gemini = join(bin, "gemini");
  writeFileSync(gemini, `#!/bin/sh\nexec node "${FAKE_AGENT}"\n`);
  chmodSync(gemini, 0o755);
  const { app, page } = await launch(box, {
    env: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, FRAMESHELL_AGENT_COMMANDS: "fake-agent=gemini" },
  });
  try {
    const guide = page.getByTestId("agent-guide");
    await expect(guide.getByRole("heading", { name: "Talk to an agent" })).toBeVisible();
    // Every catalog agent is listed: found ones to start, the rest with their install command.
    await guide.getByRole("button", { name: "Start Gemini CLI" }).click();
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");
    expect(await terminalText(page)).toContain(gemini);

    await expect(guide.getByText("Ask it to…")).toBeVisible({ timeout: 15_000 });
    await guide.getByRole("button", { name: "Add subtitles" }).click();
    await expect.poll(() => terminalText(page)).toContain("Add subtitles");
    expect(await terminalText(page)).not.toContain("SUBMITTED");

    await guide.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByTestId("agent-guide-show")).toBeVisible();
  } finally {
    await app.close();
  }
});
