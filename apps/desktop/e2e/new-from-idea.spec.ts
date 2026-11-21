import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox, terminalText } from "./harness.js";

// A video made from an idea: the Welcome form writes an empty project whose formats go in through the daemon,
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
    await form.getByLabel("Horizontal 16:9 (1920x1080)", { exact: true }).uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toHaveText("Choose at least one format.");
    await form.getByLabel("Horizontal 16:9 (1920x1080)", { exact: true }).check();
    await form.getByLabel("Vertical 9:16 (1080x1920)", { exact: true }).check();
    // With two ticked, either can be the main format (#750): the vertical one here.
    await expect(form.getByLabel("Make Horizontal 16:9 (1920x1080) the main format")).toBeChecked();
    await form.getByLabel("Make Vertical 9:16 (1080x1920) the main format").check();
    await form.getByLabel("A web page to start from (optional)").fill("spring sale");
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toContainText("not a web address");
    expect(existsSync(join(ideas, "Spring reel"))).toBe(false);

    // A bare host gets https:// (#752); what the video is about goes into the brief.
    await form.getByLabel("A web page to start from (optional)").fill("example.com/spring");
    await form.getByLabel("What is the video about? (optional)").fill("Three spring products");
    await form.getByLabel("Rough length").selectOption({ label: "About 30 seconds" });
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("Spring reel", { timeout: 60_000 });

    // The formats went in through the daemon: the main one is the project's size, the other is added.
    const dir = join(ideas, "Spring reel");
    const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));
    expect(config).toMatchObject({ resolution: { width: 1080, height: 1920 } });
    expect(config.formats.map((format: { id: string }) => format.id)).toEqual(["9x16", "16x9"]);
    const journal = readFileSync(join(dir, ".frameshell", "history", "project.config.jsonl"), "utf8");
    expect(journal).toContain("format:16x9");
    // No footage: the timeline has no clips.
    expect(JSON.parse(readFileSync(join(dir, "timelines", "main.json"), "utf8")).tracks.flatMap((track: { clips: unknown[] }) => track.clips)).toEqual([]);

    // With no agent running the guide says what to do; with one running, the film is its first suggestion, unsent.
    const guide = page.getByTestId("agent-guide");
    await expect(guide.getByText("Your project is ready, with its formats.", { exact: false })).toBeVisible();
    // The brief lives in the project (#752), and its prompt can be copied with no agent running.
    const written = readFileSync(join(dir, "brief.md"), "utf8");
    expect(written).toContain("# Spring reel");
    expect(written).toContain("- Formats: 9x16 (main), 16x9");
    expect(written).toContain("Three spring products");
    await expect(guide.locator(".agent-guide-idea-text")).toContainText('"Spring reel"');
    await expect(guide.getByTestId("agent-guide-idea-copy")).toBeVisible();
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
    expect(typed).toContain("Threespringproducts");
    // Used once: the chip goes, the suggestions are the idea project's own, and one link offers the prompt again.
    await expect(guide.getByTestId("agent-guide-idea")).toHaveCount(0);
    await expect(guide.getByRole("button", { name: "Export a draft" })).toBeVisible();
  } finally {
    await app.close();
  }
});
