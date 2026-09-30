import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { MediaStore, RECIPE_VERSION } from "@frameshell/core";
import { connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";

// Asset events (#69): an imported file shows its waveform on the timeline from the daemon's
// `asset.changed`, with no polling and no timeline change. The e2e machines have no ffmpeg, so the ingest
// is a cache hit: the derived media for these exact bytes is already in the project's media cache.
const box = sandbox("media");
const bytes = Buffer.from("voice take, never decoded: its derived media is already cached\n");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const store = new MediaStore(box.projectDir);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const key = store.key(hash, 30);
  const waveform = `.frameshell/waveforms/${key}.json`;
  mkdirSync(join(box.projectDir, ".frameshell", "waveforms"), { recursive: true });
  // A tone: loud enough that every pixel column of the clip gets a bar.
  writeFileSync(join(box.projectDir, waveform), JSON.stringify({ peaksPerSecond: 10, peaks: Array(30).fill([-90, 90]) }));
  await store.writeManifest(key, {
    version: 1,
    recipe: RECIPE_VERSION,
    fps: 30,
    hash,
    media: { duration: 3, format: "wav", video: null, audio: { codec: "pcm_s16le", sampleRate: 48000, channels: 1 } },
    proxy: null,
    sidecar: null,
    waveform: { path: waveform, peaksPerSecond: 10 },
    thumbnails: null,
  });
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

const lanes = () => page.getByTestId("timeline-lanes");

test("a waveform appears when its asset finishes ingest, without polling or a timeline change", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "1");
  await expect(lanes()).toHaveAttribute("data-media-drawn", "0");

  // Imported by another client, as the agent would with `frameshell import`.
  const source = join(box.projectDir, "..", "voice.wav");
  writeFileSync(source, bytes);
  const cli = await connectToDaemon(box.socketPath, { client: "cli/e2e" });
  try {
    const { imported } = await cli.request("asset.import", { cwd: box.projectDir, files: [source] });
    expect(imported.map((entry) => entry.asset)).toEqual(["assets/voice.wav"]);
  } finally {
    cli.close();
  }

  // Before #69 the panel re-read assets only on a timeline revision or while one was ingesting: never here.
  await expect(lanes()).toHaveAttribute("data-media-drawn", "1");
  await expect(lanes()).toHaveAttribute("data-revision", "0");
});
