import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { MediaStore, RECIPE_VERSION } from "@frameshell/core";
import { launch, sandbox } from "./harness.js";

// Media from Files onto the timeline without an agent (#738): the file menu's "Add to timeline" and a drag onto the
// lanes. The e2e machines have no ffmpeg, so each take's derived media is already in the project's media cache.
const box = sandbox("media");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

/** Put `name` in assets/ with cached media of `seconds` of sound, so `clip.add` reads its length without ffprobe. */
async function cachedTake(name: string, seconds: number): Promise<void> {
  const bytes = Buffer.from(`take ${name}, never decoded\n`);
  const store = new MediaStore(box.projectDir);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await store.writeManifest(store.key(hash, 30), {
    version: 1,
    recipe: RECIPE_VERSION,
    fps: 30,
    hash,
    media: { duration: seconds, format: "wav", video: null, audio: { codec: "pcm_s16le", sampleRate: 48000, channels: 1 } },
    proxy: null,
    sidecar: null,
    waveform: null,
    thumbnails: null,
  });
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  writeFileSync(join(box.projectDir, "assets", name), bytes);
}

const lanes = () => page.getByTestId("timeline-lanes");
const row = (path: string) => page.getByRole("treeitem", { name: path, exact: true }).getByRole("button").first();
const audioClips = () =>
  JSON.parse(readFileSync(join(box.projectDir, "timelines", "main.json"), "utf8")).tracks.find((track: { id: string }) => track.id === "t_audio").clips as {
    asset: string;
    start: number;
  }[];

test.beforeAll(async () => {
  await cachedTake("voice.wav", 3);
  await cachedTake("take-2.wav", 2);
  await cachedTake("take-3.wav", 2);
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("a file's menu in assets/ adds it to the end of the first audio track", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "1");
  await page.getByRole("treeitem", { name: "assets", exact: true }).getByRole("button").first().click();
  await row("assets/take-2.wav").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to timeline" }).click();
  await expect(lanes()).toHaveAttribute("data-clips", "2");
  expect(audioClips().map((clip) => [clip.asset, clip.start])).toEqual([
    ["assets/voice.wav", 0],
    ["assets/take-2.wav", 3],
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Added 1 clip to the timeline." })).toBeVisible();
});

test("dragging a file from Files onto the timeline adds it", async () => {
  // The drag as the browser runs it, one DataTransfer from dragstart to drop (the terminal covers part of the lanes for the mouse).
  const data = await page.evaluateHandle(() => new DataTransfer());
  await row("assets/take-3.wav").dispatchEvent("dragstart", { dataTransfer: data });
  const scroller = page.locator(".timeline-scroller");
  const box = (await scroller.boundingBox())!;
  const at = { dataTransfer: data, clientX: box.x + 300, clientY: box.y + box.height - 2 };
  await scroller.dispatchEvent("dragover", at);
  await scroller.dispatchEvent("drop", at);
  await expect(lanes()).toHaveAttribute("data-clips", "3");
  expect(audioClips().map((clip) => clip.asset)).toContain("assets/take-3.wav");
});

test("files outside assets/ have no Add to timeline", async () => {
  await row("frameshell.json").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add to timeline" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});
