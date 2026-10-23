import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";

// Review mode (ADR 0019, #320, #321) in the built app: the switch in the History view, an agent's transaction
// waiting as a proposal behind the bar, Before / After on preview and timeline, Accept applying it, Reject
// discarding the next one. The agent is the CLI the test runs, as an `agent:claude` session; real daemon.
const box = sandbox("history");
const mainFile = join(box.projectDir, "timelines", "main.json");
const cliBin = join(import.meta.dirname, "..", "..", "..", "packages", "cli", "dist", "bin", "frameshell.js");
const run = promisify(execFile);

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

/** One `frameshell` command as the agent session `claude` (author `agent:claude:review-agent`). */
async function agent(...args: string[]): Promise<void> {
  await run(process.execPath, [cliBin, ...args], {
    cwd: box.projectDir,
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: box.socketPath,
      FRAMESHELL_DATA_DIR: box.dataDir,
      FRAMESHELL_CONFIG_DIR: box.configDir,
      FRAMESHELL_SESSION: "review-agent",
      FRAMESHELL_AGENT: "claude",
    },
    timeout: 60_000,
  });
}

const bar = () => page.getByRole("region", { name: "Agent proposal" });
const lanes = () => page.getByTestId("timeline-lanes");
const clip = (id: string) => page.locator(`li[data-clip="${id}"]`);
const clipIds = () => page.locator("li[data-clip]");
const fileClips = (): string[] =>
  JSON.parse(readFileSync(mainFile, "utf8")).tracks.flatMap((track: { clips: { id: string }[] }) => track.clips.map((entry) => entry.id));

async function click(locator: ReturnType<Page["locator"]>): Promise<void> {
  const target = await laidOutBox(locator);
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
}

test("review mode is off by default: an agent change applies at once and no bar shows", async () => {
  await click(page.getByRole("tab", { name: "History" }));
  await expect(page.getByLabel("Review agent changes before applying")).not.toBeChecked();
  await agent("track", "add", "audio", "--name", "Voice");
  await expect(lanes()).toHaveAttribute("data-revision", "1", { timeout: 30_000 });
  await expect(bar()).toHaveCount(0);
});

test("the switch turns review mode on", async () => {
  await page.getByLabel("Review agent changes before applying").check();
  await expect(page.getByLabel("Review agent changes before applying")).toBeChecked();
});

test("an agent's transaction shows the bar, building and then ready on After", async () => {
  await agent("tx", "begin", "Remove the middle clip");
  await agent("clip", "remove", "c_two");
  await expect(bar()).toHaveAttribute("data-state", "building", { timeout: 30_000 });
  await expect(bar()).toContainText("claude is working…");
  await expect(bar().getByRole("button", { name: "Accept" })).toBeDisabled();
  // Nothing reached the file.
  expect(fileClips()).toContain("c_two");

  await agent("tx", "commit");
  await expect(bar()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(bar()).toContainText("Remove the middle clip");
  await expect(bar()).toContainText("claude proposes changes");
  await expect(bar()).toContainText("1 operation");
  await expect(bar().getByRole("button", { name: "Accept" })).toBeEnabled();
  await expect(bar()).toHaveAttribute("data-side", "after");
});

test("the proposed cut is visible only in After, marked on the timeline", async () => {
  await expect(clip("c_two")).toHaveCount(0);
  await expect(lanes()).toHaveAttribute("data-diff", "removed:c_two");
  await expect(page.locator(".timeline-diff-legend")).toContainText("1 removed");

  await bar().getByRole("button", { name: "Before" }).click();
  await expect(bar()).toHaveAttribute("data-side", "before");
  await expect(clip("c_two")).toHaveCount(1);
  await expect(lanes()).not.toHaveAttribute("data-diff", /.+/);
  expect(fileClips()).toContain("c_two");

  await bar().getByRole("button", { name: "After" }).click();
  await expect(clip("c_two")).toHaveCount(0);
});

test("Accept applies the proposal to the timeline file and removes the bar", async () => {
  await bar().getByRole("button", { name: "Accept" }).click();
  await expect(bar()).toHaveCount(0);
  await expect.poll(fileClips).not.toContain("c_two");
  await expect(clip("c_two")).toHaveCount(0);
  await expect(clipIds()).toHaveCount(3);
});

test("Reject discards the next proposal; the file and the timeline stay as they were", async () => {
  await agent("tx", "begin", "Move the card");
  await agent("clip", "move", "c_card", "--start", "25");
  await agent("tx", "commit");
  await expect(bar()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(bar()).toContainText("Move the card");
  await expect(lanes()).toHaveAttribute("data-diff", "moved:c_card");

  await bar().getByRole("button", { name: "Reject" }).click();
  await expect(bar()).toHaveCount(0);
  await expect(lanes()).not.toHaveAttribute("data-diff", /.+/);
  const card = JSON.parse(readFileSync(mainFile, "utf8")).tracks.flatMap((track: { clips: { id: string; start: number }[] }) => track.clips).find((entry: { id: string }) => entry.id === "c_card");
  expect(card.start).toBe(20);
  await expect(page.locator('li[data-clip="c_card"]')).toHaveText(/00:00:20:00 to 00:00:22:00/);
});
