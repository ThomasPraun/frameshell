import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { isWindows, laidOutBox, launch, runInTerminal, sandbox, terminalText } from "./harness.js";

// History panel (#18) in the built app: the agent edits from the integrated terminal in a labeled transaction, a
// direct file edit follows; the panel lists both live, marks a selected entry's changes on the timeline, and reverts
// a transaction or one operation, reporting conflicts. Real daemon; generated `titles` clips need no media.
const box = sandbox("history");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

const lanes = () => page.getByTestId("timeline-lanes");
const clipItems = () => page.getByRole("list", { name: "Timeline clips" }).getByRole("listitem");
const rows = () => page.locator(".history > .history-item");
/** History row of the transaction whose title is `title`. */
const row = (title: string) => rows().filter({ has: page.locator(".history-title", { hasText: title }) });

/** Click the middle of `locator` once it is laid out (slow packaged-app runners). */
async function clickLaidOut(locator: ReturnType<Page["locator"]>): Promise<void> {
  const target = await laidOutBox(locator);
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
}

/** Journal lines: operation and author, oldest first. */
function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

test("the History view starts empty", async () => {
  await expect(lanes()).toHaveAttribute("data-revision", "0");
  await clickLaidOut(page.getByRole("tab", { name: "History" }));
  await expect(page.locator(".panel-body .empty")).toContainText("No changes yet");
});

test("lists the agent's labeled transaction live, by author, with its operation count", async () => {
  await runInTerminal(page, 'frameshell tx begin "tighten intro"');
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("Began tx_");
  await runInTerminal(page, "frameshell clip remove c_two");
  await expect(lanes()).toHaveAttribute("data-revision", "1", { timeout: 30_000 });
  await expect(row("tighten intro")).toHaveCount(1);
  await expect(row("tighten intro").locator(".history-count")).toHaveText("1 op");

  await runInTerminal(page, "frameshell clip move c_three --start 4");
  await expect(lanes()).toHaveAttribute("data-revision", "2", { timeout: 30_000 });
  await runInTerminal(page, "frameshell tx commit");
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("Committed tx_");

  const agent = row("tighten intro");
  await expect(agent.locator(".history-count")).toHaveText("2 ops");
  await expect(agent.locator(".history-author")).toContainText(/^Terminal\s*term-/);
  await expect(agent.locator(".history-time")).toHaveText(/\d\d:\d\d:\d\d/);
});

test("selecting a transaction marks what it did on the timeline and selects the clips it left", async () => {
  const agent = row("tighten intro");
  const tx = await agent.getAttribute("data-tx");
  await clickLaidOut(agent.locator(".history-main"));
  await expect(agent).toHaveAttribute("data-selected", "true");
  await expect(lanes()).toHaveAttribute("data-diff", "removed:c_two moved:c_three");
  await expect(lanes()).toHaveAttribute("data-selected", "c_three");
  await expect(page.locator(".timeline-diff-legend")).toHaveAttribute("data-history", tx!);
  await expect(agent.locator(".history-diff")).toHaveText(/1 removed.*1 moved/);
});

test("a direct file edit shows up as its own entry, by File", async () => {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips.find((clip: { id: string }) => clip.id === "c_three").start = 5;
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(lanes()).toHaveAttribute("data-revision", "3", { timeout: 30_000 });
  const file = row("Direct edit");
  await expect(file.locator(".history-author")).toHaveText("File");
  // Newest first.
  await expect(rows().first()).toHaveAttribute("data-tx", (await file.getAttribute("data-tx"))!);
});

test("reverting the agent's transaction is refused while the file edit changed the same clip, naming it", async () => {
  const agent = row("tighten intro");
  await clickLaidOut(agent.locator(".history-main"));
  await agent.getByRole("button", { name: /^Revert tx_/ }).click();
  const notice = agent.locator(".history-notice");
  await expect(notice).toContainText("Later changes touch the same clips");
  await expect(notice.locator(".history-conflicts li")).toHaveText([/Direct edit \(File\)\s*c_three/]);
  await expect(lanes()).toHaveAttribute("data-revision", "3");
});

test("reverting a single operation undoes just it, as a ui revert", async () => {
  const file = row("Direct edit");
  await clickLaidOut(file.locator(".history-expand"));
  const op = file.locator(".history-ops li").first();
  await op.getByRole("button", { name: /^Revert operation op_/ }).click();
  await expect(lanes()).toHaveAttribute("data-revision", "4", { timeout: 30_000 });
  await expect(page.locator('li[data-clip="c_three"]')).toHaveText(/^V1: titles, 00:00:04:00 to 00:00:07:00/);
  // The revert is listed and selected: the timeline now marks what it changed.
  await expect(rows().first().locator(".history-title")).toHaveText(/^Revert op_/);
  await expect(rows().first()).toHaveAttribute("data-selected", "true");
  await expect(lanes()).toHaveAttribute("data-diff", "moved:c_three");
});

test("then the agent's transaction reverts, restoring the removed clip", async () => {
  const agent = row("tighten intro");
  await clickLaidOut(agent.locator(".history-main"));
  await agent.getByRole("button", { name: /^Revert tx_/ }).click();
  await expect(lanes()).toHaveAttribute("data-revision", "5", { timeout: 30_000 });
  await expect(clipItems()).toHaveText([
    "V2: titles, 00:00:20:00 to 00:00:22:00",
    "V1: titles, 00:00:00:00 to 00:00:04:00",
    // The revert is selected, and with it the clips it changed.
    "V1: titles, 00:00:04:00 to 00:00:10:00, selected",
    "V1: titles, 00:00:12:00 to 00:00:15:00, selected",
  ]);
  await expect(lanes()).toHaveAttribute("data-diff", "added:c_two moved:c_three");
  expect(journaled()).toEqual([
    { op: "clip.remove", author: expect.stringMatching(/^cli:term-/) },
    { op: "clip.move", author: expect.stringMatching(/^cli:term-/) },
    { op: "timeline.patch", author: "file" },
    { op: "revert", author: "ui" },
    { op: "revert", author: "ui" },
  ]);
});

test("Escape in the panel stops marking changes", async () => {
  await expect(lanes()).toHaveAttribute("data-diff", /.+/);
  // Focus a row first: the Revert button just used was disabled while it ran, which drops focus.
  await rows().first().locator(".history-main").focus();
  await page.keyboard.press("Escape");
  await expect(lanes()).not.toHaveAttribute("data-diff", /.+/);
  await expect(page.locator(".timeline-diff-legend")).toHaveCount(0);
});

/**
 * A stand-in agent CLI: a Node process titled `claude`, as Claude Code titles itself, that runs one frameshell
 * command, the way an agent's shell tool does, once it reads a line. Unix only: the app reads the terminal's
 * foreground process with `ps`.
 */
const FAKE_AGENT =
  `node -e "process.title='claude'; process.stdin.once('data', () => { ` +
  `require('child_process').execSync('frameshell track add audio --name Voice', { stdio: 'inherit' }); process.exit(0); })"`;

test("names the agent CLI that ran commands in a terminal, on its tab and in History", async () => {
  const tab = page.locator(".terminal-tab").first();
  if (isWindows) {
    // No foreground process groups to read: the agent names itself.
    await runInTerminal(page, "$env:FRAMESHELL_AGENT='claude'; frameshell track add audio --name Voice; Remove-Item Env:FRAMESHELL_AGENT");
  } else {
    await runInTerminal(page, FAKE_AGENT);
    await expect(tab).toHaveAttribute("data-agent", "claude", { timeout: 30_000 });
    await expect(tab.locator("span")).toHaveText(/^claude \d$/);
    await page.keyboard.press("Enter");
  }
  await expect(lanes()).toHaveAttribute("data-revision", "6", { timeout: 30_000 });
  const added = row("Add track");
  await expect(added.locator(".history-author")).toContainText(/^agent: claude\s*term-/);
  expect(journaled().at(-1)).toEqual({ op: "track.add", author: expect.stringMatching(/^agent:claude:term-/) });
  // The agent quit: the tab names the shell again.
  if (!isWindows) await expect(tab).not.toHaveAttribute("data-agent", /.*/, { timeout: 30_000 });
});
