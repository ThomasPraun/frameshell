import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type ExportPreset, type MediaClip, type Timeline, parseExportPreset } from "@frameshell/schema";
import { BUILTIN_PRESETS, type Daemon, type ExportSource, compileRender, executeRender, gifSizeWarning, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// GIF export (ADR 0039 slice 2) on a real managed ffmpeg and tiny synthetic media.
const MEDIA_TIMEOUT = 180_000;

/** What a GIF holds: its size, loop count and each frame's delay in 1/100 s, read from the file's own blocks. */
interface GifInfo {
  width: number;
  height: number;
  /** Loop count of the NETSCAPE2.0 extension: 0 = forever; null when the file has none (plays once). */
  loops: number | null;
  delays: number[];
}

/** Walk the GIF blocks (header, logical screen, extensions, image data) and collect the Graphic Control Extension delays. */
function readGif(bytes: Uint8Array): GifInfo {
  const header = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
  if (header !== "GIF89a" && header !== "GIF87a") throw new Error(`not a GIF: ${header}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: GifInfo = { width: view.getUint16(6, true), height: view.getUint16(8, true), loops: null, delays: [] };
  const skipSubBlocks = (at: number) => {
    let cursor = at;
    while (bytes[cursor] !== 0) cursor += bytes[cursor]! + 1;
    return cursor + 1;
  };
  const colorTable = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  let at = 13 + colorTable(bytes[10]!);
  while (at < bytes.length && bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      const label = bytes[at + 1];
      if (label === 0xf9) info.delays.push(view.getUint16(at + 4, true));
      if (label === 0xff && Buffer.from(bytes.subarray(at + 3, at + 14)).toString("latin1") === "NETSCAPE2.0") info.loops = view.getUint16(at + 16, true);
      at = skipSubBlocks(at + 2);
    } else if (bytes[at] === 0x2c) {
      at = skipSubBlocks(at + 10 + colorTable(bytes[at + 9]!) + 1);
    } else {
      throw new Error(`unexpected GIF block 0x${bytes[at]!.toString(16)} at ${at}`);
    }
  }
  return info;
}

let dir: string;
let ffmpeg: string;
let counter: ExportSource;

beforeAll(async () => {
  dir = tempDir();
  ({ ffmpeg } = await mediaTools());
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=96x54:r=30:d=4"],
    ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=4"],
    ...["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "motion.mp4")],
  ]);
  counter = { path: join(dir, "motion.mp4"), video: { codec: "h264", still: false, width: 96, height: 54 }, audio: true };
}, MEDIA_TIMEOUT);

const timelineOf = (frames: number): Timeline => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips: [{ id: "a", type: "media", asset: "assets/motion.mp4", start: 0, in: 0, out: frames / 30 } satisfies MediaClip] }],
});

/** The built-in `gif` preset at a size and frame rate a tiny test can afford. */
const tinyGif = (fps: number | undefined): ExportPreset => {
  const { fit: _fit, ...video } = BUILTIN_PRESETS.find((preset) => preset.id === "gif")!.video;
  return { id: "gif", container: "gif", video: { ...video, width: 96, height: 54, ...(fps ? { fps } : {}) } };
};

async function renderGif(frames: number, fps: number | undefined, name: string) {
  const plan = compileRender({
    timeline: timelineOf(frames),
    fps: 30,
    preset: tinyGif(fps),
    loudness: -17,
    sources: new Map([["assets/motion.mp4", counter]]),
    resolution: { width: 96, height: 54 },
    segmentSeconds: 1,
  });
  const output = join(dir, `${name}.gif`);
  await executeRender(plan, { ffmpeg, workDir: join(dir, `work-${name}`), output });
  return { plan, output, gif: readGif(await readFile(output)) };
}

describe("gif preset", () => {
  it("is a silent preset that every other container needs audio for", () => {
    const builtin = BUILTIN_PRESETS.find((preset) => preset.id === "gif")!;
    expect(parseExportPreset(builtin)).toMatchObject({ ok: true });
    expect(builtin).not.toHaveProperty("audio");
    expect(builtin.video).toMatchObject({ codec: "gif", width: 1200, height: 1200, fit: "inside" });
    expect(parseExportPreset({ ...builtin, audio: { codec: "aac" } })).toMatchObject({ ok: false });
    expect(parseExportPreset({ ...builtin, container: "mp4" })).toMatchObject({ ok: false });
    const mp4 = BUILTIN_PRESETS.find((preset) => preset.id === "youtube-1080p")!;
    const { audio: _audio, ...silent } = mp4;
    expect(parseExportPreset(silent)).toMatchObject({ ok: false, error: expect.stringContaining("audio is required") });
  });

  it("allows video.fit only on a gif preset: a fitted box has odd sizes the other codecs refuse", () => {
    const mp4 = BUILTIN_PRESETS.find((preset) => preset.id === "youtube-1080p")!;
    expect(parseExportPreset({ ...mp4, video: { ...mp4.video, fit: "inside" } })).toMatchObject({ ok: false, error: expect.stringContaining("only for a gif preset") });
  });

  it("warns above 15 000 000 bytes, naming the size in MB, and not at the limit", () => {
    expect(gifSizeWarning(15_000_000)).toBeNull();
    expect(gifSizeWarning(15_000_001)).toContain("15.0 MB (over 15 MB)");
    expect(gifSizeWarning(21_300_000)).toContain("The GIF is 21.3 MB");
  });
});

describe("gif export (real ffmpeg)", () => {
  it(
    "writes the 4,4,5,4,4,4 centisecond delays at 24 fps, 200 cs for 48 frames, and loops forever",
    async () => {
      const { plan, gif } = await renderGif(60, 24, "g24");
      expect(plan.frames).toBe(48);
      expect(gif.delays).toHaveLength(48);
      expect(gif.delays.slice(0, 12)).toEqual([4, 4, 5, 4, 4, 4, 4, 4, 5, 4, 4, 4]);
      expect(gif.delays.reduce((a, b) => a + b, 0)).toBe(200);
      expect(gif).toMatchObject({ width: 96, height: 54, loops: 0 });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps 25 fps flat and writes 3,4,3 at the 30 fps cap",
    async () => {
      const flat = await renderGif(60, 25, "g25");
      expect(new Set(flat.gif.delays)).toEqual(new Set([4]));
      expect(flat.gif.delays).toHaveLength(50);
      const thirty = await renderGif(30, undefined, "g30");
      expect(thirty.gif.delays.slice(0, 6)).toEqual([3, 4, 3, 3, 4, 3]);
      expect(thirty.gif.delays.reduce((a, b) => a + b, 0)).toBe(100);
      const capped = compileRender({
        timeline: timelineOf(30),
        fps: 60,
        preset: tinyGif(undefined),
        loudness: -17,
        sources: new Map([["assets/motion.mp4", counter]]),
        resolution: { width: 96, height: 54 },
      });
      expect(capped.fps).toBe("30/1");
    },
    MEDIA_TIMEOUT,
  );
});

describe("render method with the gif preset", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;
  let track: string;
  let asset: string;

  beforeAll(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    await conn.request("format.add", { cwd: project, id: "9x16" });
    const { imported } = await conn.request("asset.import", { cwd: project, files: [counter.path] });
    asset = imported[0]!.asset;
    track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    await conn.request("clip.add", { cwd: project, track, asset, start: 0, in: 0, out: 1.6 });
  }, MEDIA_TIMEOUT);

  afterAll(async () => {
    conn.close();
    await daemon.close();
  });

  async function finished(id: string): Promise<JobInfo> {
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
      const job = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === id);
      if (job && job.state !== "queued" && job.state !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`job ${id} did not finish`);
  }

  it("lists the preset", async () => {
    const { presets } = await conn.request("export.presets", { cwd: project });
    expect(presets.find((preset) => preset.id === "gif")).toMatchObject({ container: "gif", video: { codec: "gif", fit: "inside" } });
  });

  it(
    "fits each format inside 1200 px: 16:9 is 1200x675, 9:16 is 675x1200, one file each that loops",
    async () => {
      const result = await conn.request("render", { cwd: project, preset: "gif", formats: ["16x9", "9x16"], out: join(project, "exports", "loop.gif") });
      expect(result.renders.map((render) => [render.format, render.width, render.height])).toEqual([
        ["16x9", 1200, 675],
        ["9x16", 675, 1200],
      ]);
      expect(result.encoder).toBe("gif");
      for (const render of result.renders) {
        const job = await finished(render.job.id);
        expect(job).toMatchObject({ state: "done", warnings: [] });
        const gif = readGif(await readFile(render.output));
        expect(render.output).toMatch(/loop-(16x9|9x16)\.gif$/);
        expect(gif).toMatchObject({ width: render.width, height: render.height, loops: 0 });
        expect(gif.delays).toHaveLength(48);
        expect(gif.delays.slice(0, 3)).toEqual([3, 4, 3]);
      }
    },
    MEDIA_TIMEOUT,
  );

  it("refuses more than 350 frames before queuing anything", async () => {
    // 1.6 s + 3 x 4 s is 13.6 s, 408 frames at 30 fps.
    await conn.request("clip.add", { cwd: project, track, asset, start: 1.6, in: 0, out: 4 });
    await conn.request("clip.add", { cwd: project, track, asset, start: 5.6, in: 0, out: 4 });
    await conn.request("clip.add", { cwd: project, track, asset, start: 9.6, in: 0, out: 4 });
    const before = (await conn.request("job.list", { cwd: project })).jobs.length;
    await expect(conn.request("render", { cwd: project, preset: "gif" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { field: "preset", reason: "gif frame cap", max: 350 },
    });
    expect((await conn.request("job.list", { cwd: project })).jobs).toHaveLength(before);
  });
});
