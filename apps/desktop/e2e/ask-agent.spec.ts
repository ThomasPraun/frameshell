import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, runInTerminal, sandbox, terminalText } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// "Ask agent" (#49) in the built app: a real daemon, a synthetic take with a hand-written transcript on the
// timeline, and a stand-in agent TUI (e2e/fake-agent.mjs: raw stdin, bracketed paste, prints SUBMITTED on
// Enter) running in the real terminal. Cmd/Ctrl+L and the context menu type SPEC §10 references at its prompt.
const box = sandbox("ask");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/talk.mp4";
const TRANSCRIPT = "transcripts/talk.words.json";
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Word k (0-based) is a tone at source k + 0.2 to k + 0.7 s. */
const TEXTS = ["one", "two", "three", "four"];
const id = (k: number) => `w_${String(k + 1).padStart(6, "0")}`;

let app: ElectronApplication;
let page: Page;

async function writeTake(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  // Written elsewhere first: the daemon's asset watcher must never see a half-written file.
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4"],
    ...["-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*220*t)*between(mod(t\\,1)\\,0.2\\,0.7):s=48000:d=4"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", file],
  ]);
  const hash = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  mkdirSync(join(box.projectDir, "transcripts"), { recursive: true });
  writeFileSync(
    join(box.projectDir, TRANSCRIPT),
    JSON.stringify({
      schemaVersion: 1,
      asset: ASSET,
      assetHash: hash,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      words: TEXTS.map((text, k) => ({ id: id(k), text, start: k + 0.2, end: k + 0.7 })),
      edits: {},
    }),
  );
  renameSync(file, join(box.projectDir, ASSET));
}

const word = (k: number) => page.locator(`.tw[data-word="${id(k)}"]`);

/** Middle of a word, once laid out. */
async function middle(k: number): Promise<{ x: number; y: number }> {
  const { x, y, width, height } = await laidOutBox(word(k));
  return { x: x + width / 2, y: y + height / 2 };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await writeTake();
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  // Current revision: the daemon journals the edit as author `file` (SPEC §6.4).
  timeline.tracks[0].clips = [{ id: "c_a", type: "media", asset: ASSET, start: 0, in: 0, out: 4 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await runInTerminal(page, `node "${FAKE_AGENT}"`);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");
});

test.afterAll(async () => {
  await app?.close();
});

test("Cmd/Ctrl+L types the selected subtitle words at the agent's prompt, focused and unsent", async () => {
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const two = await middle(1);
  const three = await middle(2);
  await page.mouse.move(two.x, two.y);
  await page.mouse.down();
  await page.mouse.move(three.x, three.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".tw.is-selected")).toHaveCount(2);
  // Off the terminal: there Ctrl+L stays the shell's clear-screen (Linux, Windows).
  await page.getByTestId("transcript").focus();
  await page.keyboard.press(`${MOD}+l`);
  const expected = '[frameshell] subtitle "two three" · 00:00:01.20–00:00:02.70 · clip c_a · words w_000002–w_000003';
  await expect.poll(() => terminalText(page)).toContain(expected);
  expect(await terminalText(page)).not.toContain("SUBMITTED");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".xterm") !== null)).toBe(true);
});

test("the context menu of a word selects it and asks about it", async () => {
  const four = await middle(3);
  await page.mouse.click(four.x, four.y, { button: "right" });
  await expect(word(3)).toHaveClass(/is-selected/);
  await page.getByRole("menuitem", { name: /Ask agent/ }).click();
  await expect.poll(() => terminalText(page)).toContain('[frameshell] subtitle "four" · 00:00:03.20–00:00:03.70 · clip c_a · word w_000004');
  expect(await terminalText(page)).not.toContain("SUBMITTED");
});

test("an explorer asset's context menu asks about the file", async () => {
  await page.getByRole("treeitem", { name: "assets", exact: true }).getByRole("button").first().click();
  const row = page.getByRole("treeitem", { name: ASSET }).getByRole("button");
  await row.click({ button: "right" });
  await expect(row).toHaveAttribute("data-picked", "true");
  await page.getByRole("menuitem", { name: /Ask agent/ }).click();
  await expect.poll(() => terminalText(page)).toContain(`[frameshell] asset ${ASSET}`);
});

test("a region drawn on the preview saves a frame capture and references it with coordinates and time", async () => {
  await page.getByRole("button", { name: "Select region" }).click();
  const frame = await laidOutBox(page.getByTestId("preview-frame"));
  await page.mouse.move(frame.x + frame.width * 0.1, frame.y + frame.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("preview-region")).toBeVisible();
  const at = Number(await page.getByTestId("timeline-lanes").getAttribute("data-playhead"));
  await page.keyboard.press(`${MOD}+l`);
  const reference = /\[frameshell\] region \(0\.(09|10|11),0\.(19|20|21)\)–\(0\.(49|50|51),0\.(59|60|61)\) @ (\d\d:\d\d:\d\d\.\d\d) · frame (\.frameshell\/context\/f_\d{4}\.png)/;
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toMatch(reference);
  const match = reference.exec(await terminalText(page))!;
  const seconds = at.toFixed(2).padStart(5, "0");
  expect(match[5]).toBe(`00:00:${seconds}`);
  const png = readFileSync(join(box.projectDir, match[6]!));
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect(await terminalText(page)).not.toContain("SUBMITTED");
});
