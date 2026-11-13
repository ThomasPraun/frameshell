import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { SUBTITLE_FONT, type Timeline, type Transcript, captionTokens, resolveStyle } from "@frameshell/schema";
import { type Daemon, compileFrame, fontSource, readCaptionTokens, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// Captions take the project style as their base (ADR 0028 decision 11): colours and the face of style.json reach
// the burned subtitles of `frame` and `render`, and review measures them in the same face.
const MEDIA_TIMEOUT = 180_000;
const W = 320;
const H = 180;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let ffmpeg: string;

beforeAll(async () => {
  ffmpeg = (await mediaTools()).ffmpeg;
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const config = JSON.parse(readFileSync(join(project, "frameshell.json"), "utf8")) as Record<string, unknown>;
  await conn.request("file.write", { path: join(project, "frameshell.json"), content: JSON.stringify({ ...config, resolution: { width: W, height: H } }) });
  const footage = join(tempDir(), "dark.mp4");
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x202020:s=${W}x${H}:r=30:d=1`],
    ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", footage],
  ]);
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const asset = imported[0]!.asset;
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset, start: 0, in: 0, out: 1 });
  await conn.request("track.add", { cwd: project, kind: "subtitles", follows: video });
  const transcript = {
    schemaVersion: 1,
    asset,
    assetHash: `sha256:${"0".repeat(64)}`,
    provider: "test",
    model: "test",
    // At 0.2 s HOLA is spoken (the highlight colour), MUNDO shows in the text colour.
    words: [
      { id: "w_000001", text: "HOLA", start: 0.1, end: 0.3 },
      { id: "w_000002", text: "MUNDO", start: 0.5, end: 0.9 },
    ],
    edits: {},
  } as Transcript;
  await conn.request("file.write", { path: join(project, "transcripts", "dark.words.json"), content: JSON.stringify(transcript) });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

/** Pixels of a `frame` capture at 0.2 s that are near `[r, g, b]`. */
async function pixelsNear(name: string, [r, g, b]: [number, number, number]): Promise<number> {
  const out = join(tempDir(), `${name}.png`);
  await conn.request("frame", { cwd: project, at: 0.2, out });
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let count = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) if (Math.abs(raw[i]! - r) < 50 && Math.abs(raw[i + 1]! - g) < 50 && Math.abs(raw[i + 2]! - b) < 50) count++;
  return count;
}

describe("captions in the project style", () => {
  it(
    "burn in the style's ink over the preset's white once style.json sets it, in its project face",
    async () => {
      expect(await pixelsNear("plain", [0, 255, 0])).toBe(0);
      const white = await pixelsNear("plain-white", [255, 255, 255]);
      expect(white).toBeGreaterThan(50);

      await conn.request("style.set", { cwd: project, path: "colors.ink", value: "#00ff00" });
      expect(await pixelsNear("ink", [0, 255, 0])).toBeGreaterThan(white / 2);
      expect(await pixelsNear("ink-white", [255, 255, 255])).toBeLessThan(white / 10);

      mkdirSync(join(project, "assets", "fonts"), { recursive: true });
      copyFileSync(fontSource(SUBTITLE_FONT.file), join(project, "assets", "fonts", "Brand.ttf"));
      await conn.request("style.set", { cwd: project, path: "fonts.captions", value: { family: "Brand", file: "assets/fonts/Brand.ttf" } });
      expect(await pixelsNear("face", [0, 255, 0])).toBeGreaterThan(white / 2);
      // Review measures the cues in the same face: the safe sheet reads the project font's metrics.
      const review = await conn.request("review", { cwd: project, platform: "youtube", sheets: ["safe"] });
      expect(review.warnings).toEqual([]);
      expect(review.safeZones).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it("reads the face's metrics from its file, and warns and falls back when it cannot", async () => {
    const timeline = JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as Timeline;
    const read = await readCaptionTokens(project, timeline);
    expect(read).toEqual({
      tokens: expect.objectContaining({
        values: { color: "#00ff00" },
        font: { family: SUBTITLE_FONT.family, file: "assets/fonts/Brand.ttf", ascent: SUBTITLE_FONT.ascent, descent: SUBTITLE_FONT.descent },
      }),
      warnings: [],
    });
    await conn.request("style.set", { cwd: project, path: "fonts.captions", value: { family: "Brand", file: "assets/fonts/Gone.ttf" } });
    expect(await readCaptionTokens(project, timeline)).toMatchObject({
      tokens: { font: { file: null } },
      warnings: [`fonts.captions.file assets/fonts/Gone.ttf cannot be used (it does not exist): captions use ${SUBTITLE_FONT.family}.`],
    });
    const rendered = await conn.request("render", { cwd: project, timeline: "main" });
    expect(rendered.warnings).toContain(`fonts.captions.file assets/fonts/Gone.ttf cannot be used (it does not exist): captions use ${SUBTITLE_FONT.family}.`);
    // Without subtitle tracks the style is not read for captions at all.
    expect(await readCaptionTokens(project, { ...timeline, tracks: timeline.tracks.filter((track) => track.kind !== "subtitles") })).toEqual({ warnings: [] });
    await conn.request("style.set", { cwd: project, path: "fonts.captions", value: null });
  });
});

describe("export plans of styled captions", () => {
  it("burn with the project face's family and metrics and copy its file, the bundled one only for a cover", () => {
    const timeline: Timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "c", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 1 }] },
        { id: "s1", kind: "subtitles", follows: "v1" },
      ],
    };
    const transcript = { schemaVersion: 1, asset: "assets/a.mp4", assetHash: `sha256:${"0".repeat(64)}`, provider: "t", model: "t", words: [{ id: "w_000001", text: "hola", start: 0, end: 0.9 }], edits: {} } as Transcript;
    const font = { family: "Brand, Sans", file: "assets/fonts/Brand.ttf", ascent: 0.9, descent: 0.25 };
    const captions = captionTokens(resolveStyle({ schemaVersion: 1, colors: { ink: "#00ff00" } }), font);
    const plan = compileFrame({
      timeline,
      fps: 30,
      sources: new Map([["assets/a.mp4", { path: "/a.mp4", video: { codec: "h264", still: false, width: W, height: H }, audio: true }]]),
      transcripts: new Map([[transcript.asset, transcript]]),
      captions,
      resolution: { width: W, height: H },
      width: W,
      height: H,
      at: 0.5,
      output: "out.png",
    });
    expect(plan.fonts).toEqual(["assets/fonts/Brand.ttf"]);
    const fontSize = Math.round(SUBTITLE_FONT_SIZE * Math.min(W, H));
    expect(plan.files["subtitles.ass"]).toContain(`Style: t0,Brand Sans,${Number((fontSize * 1.15).toFixed(3))},&H0000FF00&,`);
    expect(plan.files["subtitles.ass"]).toContain(`\\pos(${W / 2},${Number((H - 0.12 * H).toFixed(3))})`);
  });
});

/** Font size of the default preset (big-keyword), fraction of the short side. */
const SUBTITLE_FONT_SIZE = 0.065;
