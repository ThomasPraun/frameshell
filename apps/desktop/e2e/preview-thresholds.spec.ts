// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
// ADR 0001 pass thresholds on the real app (#15). Opt-in, real time, long: FRAMESHELL_PREVIEW_MEASURE=1.
//   FRAMESHELL_PREVIEW_MEASURE_MINUTES  source length (default 30, the ADR fixture; the spike's cut list fits in it)
//   FRAMESHELL_PREVIEW_MEASURE_CUTS     play only the first N cuts (default: all, 200 at 30 min)
// Source, project and ingest outputs are kept under .cache/preview-measure/ and reused by later runs.
// Results: test-results/preview-thresholds/<run>.{json,md} and the console. Recorded runs: docs/research/preview-playback-measurements.md.
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { type Sandbox, isWindows, launch } from "./harness.js";
import { makeSource, testFfmpeg } from "./media.js";
import { type RunLog, analyze, checkThresholds, spikeCutList } from "./preview-analysis.js";
import { installFrameReader, waitForIngest } from "./preview-probe.js";

const ENABLED = process.env["FRAMESHELL_PREVIEW_MEASURE"] === "1";
const MINUTES = Number(process.env["FRAMESHELL_PREVIEW_MEASURE_MINUTES"] || 30);
const CUTS = process.env["FRAMESHELL_PREVIEW_MEASURE_CUTS"] ? Number(process.env["FRAMESHELL_PREVIEW_MEASURE_CUTS"]) : Infinity;
const FPS = 30;
const SR = 48_000;
const ASSET = "assets/source.mp4";

test.skip(!ENABLED, "real-time measurement: set FRAMESHELL_PREVIEW_MEASURE=1");

test("preview meets the ADR 0001 pass thresholds on the spike's cut list", async () => {
  test.setTimeout(3 * 60 * 60 * 1000);
  const root = fileURLToPath(new URL(`../../../.cache/preview-measure/${MINUTES}min/`, import.meta.url));
  const projectDir = join(root, "project");
  if (!existsSync(projectDir)) cpSync(join(import.meta.dirname, "fixtures", "preview"), projectDir, { recursive: true });
  const ffmpeg = await testFfmpeg();
  const source = join(root, "source.mp4");
  if (!existsSync(source)) {
    // Same fixture as the spike: 1080p30 testsrc2 with the frame barcode and a 220 Hz sine.
    await makeSource(ffmpeg, join(root, "source.tmp.mp4"), { seconds: MINUTES * 60, width: 1920, height: 1080 });
    renameSync(join(root, "source.tmp.mp4"), source);
  }
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  if (!existsSync(join(projectDir, ASSET))) linkSync(source, join(projectDir, ASSET));

  let segments = spikeCutList(MINUTES * 60, FPS);
  if (Number.isFinite(CUTS)) segments = segments.slice(0, CUTS + 1);
  const mainFile = join(projectDir, "timelines", "main.json");
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  // Current revision: the daemon journals the edit as author `file` (SPEC §6.4).
  timeline.tracks = [
    {
      id: "v1",
      kind: "video",
      name: "Cut list",
      clips: segments.map((s, k) => ({ id: `c_${k}`, type: "media", asset: ASSET, start: s.pF / FPS, in: s.inF / FPS, out: s.outF / FPS })),
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));

  const work = mkdtempSync(join(tmpdir(), "fs-measure-"));
  const box: Sandbox = {
    projectDir,
    socketPath: isWindows ? `\\\\.\\pipe\\frameshell-measure-${Date.now()}` : join(work, "d.sock"),
    dataDir: join(work, "data"),
    configDir: join(work, "config"),
  };
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  process.env["FRAMESHELL_PREVIEW_PROBE"] = "1";
  const { app, page } = await launch(box);
  try {
    await waitForIngest(page, ASSET, 30 * 60 * 1000);
    await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", String(segments.length));
    const programFrames = segments.at(-1)!.pF + segments.at(-1)!.outF - segments.at(-1)!.inF;
    await expect(page.locator(".preview-duration")).toHaveText(timecode(programFrames));
    await installFrameReader(page);
    await page.evaluate(() => {
      const w = window as unknown as { readShownFrame: () => number; probes: [number, number][] };
      w.probes = [];
      const loop = (now: number) => {
        w.probes.push([now, w.readShownFrame()]);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    // Let window and decoder start-up stalls settle, as the spike's 2 s warm-up did.
    await page.waitForTimeout(2000);

    const blocks: { start: number; data: Float32Array }[] = [];
    const timestamps: { contextTime: number; performanceTime: number }[] = [];
    const drain = async () => {
      const got = await page.evaluate(() => {
        const probe = (window as unknown as { frameshellPreviewProbe: { drainAudio(): { start: number; data: string }[]; drainTimestamps(): { contextTime: number; performanceTime: number }[] } }).frameshellPreviewProbe;
        return { audio: probe.drainAudio(), timestamps: probe.drainTimestamps() };
      });
      for (const block of got.audio) {
        const bytes = Buffer.from(block.data, "base64");
        blocks.push({ start: block.start, data: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice() });
      }
      timestamps.push(...got.timestamps);
    };
    await drain();
    blocks.length = 0;

    await page.keyboard.press("Home");
    await page.getByRole("button", { name: "Play" }).click();
    const anchor = await expect
      .poll(() => page.evaluate(() => (window as unknown as { frameshellPreviewProbe: { anchor(): unknown } }).frameshellPreviewProbe.anchor()))
      .not.toBeNull()
      .then(() => page.evaluate(() => (window as unknown as { frameshellPreviewProbe: { anchor(): { frame: number; sample: number } } }).frameshellPreviewProbe.anchor()));
    const deadline = Date.now() + (programFrames / FPS + 120) * 1000;
    while ((await page.getByTestId("preview-frame").getAttribute("data-playing")) && Date.now() < deadline) {
      await drain();
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(500);
    await drain();
    const probes = await page.evaluate(() => (window as unknown as { probes: [number, number][] }).probes);
    const stats = await page.evaluate(() => (window as unknown as { frameshellPreviewProbe: { stats(): unknown } }).frameshellPreviewProbe.stats());

    // Recorded blocks into one buffer on the context-frame axis.
    blocks.sort((a, b) => a.start - b.start);
    const audioStart = blocks[0]!.start;
    const last = blocks.at(-1)!;
    const audio = new Float32Array(last.start + last.data.length - audioStart);
    let gaps = 0;
    blocks.forEach((b, i) => {
      if (i > 0 && b.start !== blocks[i - 1]!.start + blocks[i - 1]!.data.length) gaps++;
      audio.set(b.data, b.start - audioStart);
    });

    const assets = await page.evaluate(() => (window as unknown as { frameshell: FrameshellApi }).frameshell.media.assets());
    const sidecar = assets.find((a) => a.path === ASSET)!.sidecar!;
    const pcmBytes = readFileSync(join(projectDir, sidecar.path));
    const pcm = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
    const hz = SR / FPS;
    const starts = segments.map((s) => s.pF * hz);
    const expected = (p: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= p) lo = mid;
        else hi = mid - 1;
      }
      const s = segments[lo]!;
      const i = p - starts[lo]!;
      const n = (s.outF - s.inF) * hz;
      return ((pcm[s.inF * hz + i] ?? 0) / 32768) * Math.max(0, Math.min(1, i / 96, (n - 1 - i) / 96));
    };

    const run: RunLog = { fps: FPS, sampleRate: SR, segments, probes, anchor, audioStart, audio, audioGaps: gaps, timestamps, expected };
    const summary = analyze(run);
    const verdicts = checkThresholds(summary);
    const name = `real-app-${MINUTES}min-${segments.length - 1}cuts`;
    const lines = [
      `# Preview thresholds (ADR 0001), ${name}`,
      "",
      ...verdicts.map((v) => `- ${v.id} ${v.pass ? "pass" : "FAIL"}  ${v.detail}`),
      "",
      "```json",
      JSON.stringify({ summary, engine: stats }, null, 2),
      "```",
    ];
    const out = join(import.meta.dirname, "..", "test-results", "preview-thresholds");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.json`), JSON.stringify({ summary, verdicts, engine: stats }, null, 2));
    writeFileSync(join(out, `${name}.md`), `${lines.join("\n")}\n`);
    console.log(lines.join("\n"));
    expect(verdicts.filter((v) => !v.pass)).toEqual([]);
  } finally {
    delete process.env["FRAMESHELL_PREVIEW_PROBE"];
    await app.close();
  }
});

function timecode(frames: number): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const s = Math.floor(frames / FPS);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(frames % FPS)}`;
}
