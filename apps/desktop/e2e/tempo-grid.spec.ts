// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";
import { addBarcodeAsset } from "./preview-probe.js";

// The beat grid (ADR 0029 slice 3) in the built app: the timeline follows a music clip's beats file, draws it, and
// dragged clips snap to it; a hand edit of the beats file changes the grid live. Real daemon and ffprobe; the beats
// file is written by hand (`exact` detector), so no detector runs.
const box = sandbox("editing");
const MUSIC = "assets/music.mp4";
const BEATS = join(box.projectDir, "beats", "music.beats.json");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let daemon: DaemonConnection;

/** 120 BPM: a beat every 0.5 s from 0.5 s in the music, 19 of them in its first 10 s; a bar every 4 beats. */
const beatsFile = (edits: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  asset: MUSIC,
  assetHash: `sha256:${"0".repeat(64)}`,
  detector: "exact",
  bpm: 120,
  meter: 4,
  downbeat: 0,
  confidence: 1,
  beats: Array.from({ length: 19 }, (_, index) => 0.5 + index * 0.5),
  edits,
});

function writeBeats(content: unknown): void {
  mkdirSync(join(box.projectDir, "beats"), { recursive: true });
  writeFileSync(BEATS, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addBarcodeAsset(box, "music.mp4", 10);
  ({ app, page } = await launch(box));
  // The app starts its daemon with the project; the socket can appear a moment after the boot screen is gone.
  await expect
    .poll(async () => {
      daemon = await connectToDaemon(box.socketPath, { client: "cli/e2e" }).catch(() => undefined as unknown as DaemonConnection);
      return daemon !== undefined;
    }, { timeout: 60_000 })
    .toBe(true);
  const cwd = box.projectDir;
  await daemon.request("track.add", { cwd, kind: "audio" });
  const { tracks } = await daemon.request("track.list", { cwd });
  const audio = tracks.find((track) => track.kind === "audio")!;
  await daemon.request("clip.add", { cwd, track: audio.id, asset: MUSIC, start: 2, out: 10 });
  writeBeats(beatsFile());
  const { grid } = await daemon.request("tempo.show", { cwd, timeline: "main" });
  expect(grid).toBeNull();
  const shown = await daemon.request("timeline.show", { cwd, timeline: "main" });
  const music = shown.tracks.flatMap((track) => track.clips).find((clip) => clip.asset === MUSIC)!;
  await daemon.request("tempo.set", { cwd, timeline: "main", clip: music.id });
});

test.afterAll(async () => {
  daemon?.close();
  await app?.close();
});

/** Content px as `layout.ts` stacks them: the ruler, then V2 above V1 (no marker lane or scene band here). */
const RULER = 22;
const LANE = 44;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

const grid = () => page.getByRole("list", { name: "Timeline clips" }).locator("li[data-grid]");
const scroller = () => page.locator(".timeline-scroller");

/** Screen x of timeline second `time` and the scroller's top, once the lanes are laid out. */
async function geometry(time: number): Promise<{ x: number; top: number }> {
  let box = { left: 0, top: 0, scrollLeft: 0, width: 0, scrollWidth: 0 };
  await expect
    .poll(async () => {
      box = await scroller().evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, scrollLeft: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      return box.width > 0;
    })
    .toBe(true);
  return { x: box.left + (time * box.scrollWidth) / FIT_SPAN_S - box.scrollLeft, top: box.top };
}

function savedStart(id: string): number {
  const timeline = JSON.parse(readFileSync(join(box.projectDir, "timelines", "main.json"), "utf8"));
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate: { id: string }) => candidate.id === id);
    if (clip) return clip.start;
  }
  throw new Error(`no clip ${id}`);
}

test("the grid of the music's beats file shows on the timeline: beats and bars, at the clip's place", async () => {
  await expect(grid()).toHaveCount(1);
  await expect(grid()).toHaveAttribute("data-bpm", "120");
  await expect(grid()).toHaveAttribute("data-beats", "19");
  await expect(grid()).toHaveAttribute("data-bars", "5");
  await expect(grid()).toHaveAttribute("data-grid", "on");
  await expect(grid()).toHaveText("Beat grid, 120 BPM, 4 beats to the bar");
});

test("a clip dragged near a beat snaps onto it, and the daemon gets the exact second", async () => {
  // c_card plays 20–22 on V2: carry it to start at 7.1; its start and its end (9.1) are both 0.1 s from a beat.
  const y = RULER + LANE / 2;
  const from = await geometry(21);
  const to = await geometry(8.1);
  await page.mouse.move(from.x, from.top + y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.top + y, { steps: 12 });
  await expect(page.locator(".drag-tooltip")).toContainText("Snapped to a beat");
  await page.mouse.up();
  await expect.poll(() => savedStart("c_card")).toBe(7);
});

test("a hand edit of the beats file changes the grid live: double time, then a broken file, then repaired", async () => {
  writeBeats(beatsFile({ tempo: "double" }));
  await expect(grid()).toHaveAttribute("data-bpm", "240");
  await expect(grid()).toHaveAttribute("data-beats", "37");

  writeBeats('{ "asset": "assets/music.mp4", "beats": [2, 1] }');
  await expect(grid()).toHaveCount(0);

  writeBeats(beatsFile());
  await expect(grid()).toHaveAttribute("data-bpm", "120");
});

test("a LOW confidence grid is drawn but marked low (it offers no snap points)", async () => {
  writeBeats({ ...beatsFile(), detector: "onset-flux@1", confidence: 0.3, residualMs: 4, sampleRate: 48000 });
  await expect(grid()).toHaveAttribute("data-grid", "low");
  await expect(grid()).toContainText("low confidence");
});

test("a nominal tempo needs no music", async () => {
  const cwd = box.projectDir;
  await daemon.request("tempo.set", { cwd, timeline: "main", bpm: 90 });
  await expect(grid()).toHaveAttribute("data-bpm", "90");
  await expect(grid()).toHaveAttribute("data-grid", "on");
  await daemon.request("tempo.set", { cwd, timeline: "main", clear: true });
  await expect(grid()).toHaveCount(0);
});
