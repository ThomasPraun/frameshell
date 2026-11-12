import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox, terminalText } from "./harness.js";

// A video made from an idea (#472): the Welcome form writes an empty project whose formats go in through the daemon,
// then the agent guide offers the prompt for the film. The folder dialog is replaced in main; the stand-in agent
// (fake-agent.mjs) is installed as `gemini` on PATH like in agent-guide.
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");

test.skip(process.platform === "win32", "the stand-in agent is a POSIX shell script; detection needs ps");

test("the form creates an empty project with its formats and offers the film prompt to an agent", async () => {
  const box = sandbox("demo");
  const home = join(dirname(box.projectDir), "desktop");
  const ideas = join(dirname(box.projectDir), "ideas");
  mkdirSync(home, { recursive: true });
  mkdirSync(ideas, { recursive: true });
  const bin = join(box.dataDir, "agents-bin");
  mkdirSync(bin, { recursive: true });
  const gemini = join(bin, "gemini");
  writeFileSync(gemini, `#!/bin/sh\nexec node "${FAKE_AGENT}"\n`);
  chmodSync(gemini, 0o755);

  const { app, page } = await launch(
    { ...box, projectDir: home },
    { env: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, FRAMESHELL_AGENT_COMMANDS: "fake-agent=gemini" } },
  );
  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, ideas);

    await page.getByRole("button", { name: "New video from an idea…" }).click();
    const form = page.getByRole("form", { name: "New video from an idea" });
    await form.getByRole("button", { name: "Change…" }).click();
    await expect(form.locator(".welcome-place code")).toHaveText(join(ideas, "Untitled video"));

    // Nothing is created from an empty name, no format, or an address that is not one.
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toHaveText("Give the video a name.");
    await form.getByLabel("Name of the video").fill("Spring reel");
    await form.getByLabel("Horizontal 16:9 (1920x1080)").uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toHaveText("Choose at least one format.");
    await form.getByLabel("Horizontal 16:9 (1920x1080)").check();
    await form.getByLabel("Vertical 9:16 (1080x1920)").check();
    await form.getByLabel("A web page to start from (optional)").fill("spring sale");
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toContainText("not a web address");
    expect(existsSync(join(ideas, "Spring reel"))).toBe(false);

    await form.getByLabel("A web page to start from (optional)").fill("https://example.com/spring");
    await form.getByLabel("Rough length").selectOption({ label: "About 30 seconds" });
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("Spring reel", { timeout: 60_000 });

    // The formats went in through the daemon: the first of the list is the project's size, the other is added.
    const dir = join(ideas, "Spring reel");
    const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));
    expect(config).toMatchObject({ resolution: { width: 1920, height: 1080 } });
    expect(config.formats.map((format: { id: string }) => format.id)).toEqual(["16x9", "9x16"]);
    const journal = readFileSync(join(dir, ".frameshell", "history", "project.config.jsonl"), "utf8");
    expect(journal).toContain("format:9x16");
    // No footage: the timeline has no clips.
    expect(JSON.parse(readFileSync(join(dir, "timelines", "main.json"), "utf8")).tracks.flatMap((track: { clips: unknown[] }) => track.clips)).toEqual([]);

    // With no agent running the guide says what to do; with one running, the film is its first suggestion, unsent.
    const guide = page.getByTestId("agent-guide");
    await expect(guide.getByText("Your project is ready, with its formats.")).toBeVisible();
    await guide.getByRole("button", { name: "Start Gemini CLI" }).click();
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");
    await guide.getByTestId("agent-guide-idea").click();
    await expect.poll(async () => (await terminalText(page)).replace(/\s/g, "")).toContain("threestorylines");
    // Rows wrap the long line anywhere: compare without spaces.
    const typed = (await terminalText(page)).replace(/\s/g, "");
    expect(typed).toContain('"Springreel"');
    expect(typed).toContain("https://example.com/spring");
    expect(typed).toContain("freealternative");
    expect(typed).not.toContain("SUBMITTED");
  } finally {
    await app.close();
  }
});
