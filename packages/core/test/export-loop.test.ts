import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import type { ExportPreset, MediaClip, Timeline } from "@frameshell/schema";
import { type Daemon, type ExportSource, compileRender, executeRender, muxStep, startDaemon } from "../src/index.js";
import { DUPLICATE_DIFF, MOTION_DIFF, duplicateSeam, loopSeamWarning, meanAbsDiff } from "../src/export/seam.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// Loop-safe export (ADR 0039) on a real managed ffmpeg and tiny synthetic media.
const MEDIA_TIMEOUT = 180_000;

/** PCM in MOV: decoded audio is sample-exact, so the fades can be measured to the sample. */
const TINY_MOV: ExportPreset = {
  id: "tiny-mov",
  container: "mov",
  video: { codec: "h264", width: 64, height: 64, crf: 12 },
  audio: { codec: "pcm", sampleRate: 48_000 },
};

/** Frame n of the counter is flat luma 16 + 8 * (n mod 25 + 1): a 25 frame cycle, so frame 25 repeats frame 0. */
const LEVELS = 25;
const FADE = 96;

let dir: string;
let ffmpeg: string;
let counter: ExportSource;

beforeAll(async () => {
  dir = tempDir();
  ({ ffmpeg } = await mediaTools());
  await makeCounter(join(dir, "counter.mp4"));
  counter = { path: join(dir, "counter.mp4"), video: { codec: "h264", still: false, width: 64, height: 64 }, audio: true };
}, MEDIA_TIMEOUT);

async function makeCounter(path: string): Promise<void> {
  const { ffmpeg: tool } = await mediaTools();
  await run(tool, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=black:s=64x64:r=30:d=5,geq=lum='16+8*(mod(N\\,${LEVELS})+1)':cb=128:cr=128`],
    ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=5"],
    ...["-c:v", "libx264", "-crf", "8", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path],
  ]);
}

const timelineOf = (frames: number): Timeline => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips: [{ id: "a", type: "media", asset: "assets/counter.mp4", start: 0, in: 0, out: frames / 30 } satisfies MediaClip] }],
});

const render = async (frames: number, name: string, loop: boolean, preset: ExportPreset = TINY_MOV) => {
  const plan = compileRender({
    timeline: timelineOf(frames),
    fps: 30,
    preset,
    loudness: -17,
    sources: new Map([["assets/counter.mp4", counter]]),
    resolution: { width: 64, height: 64 },
    ...(loop ? { loop } : {}),
  });
  const output = join(dir, `${name}.${preset.container}`);
  await executeRender(plan, { ffmpeg, workDir: join(dir, `work-${name}`), output });
  return { plan, output };
};

async function audioSamples(path: string): Promise<Float32Array> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"]);
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

describe("seam judgement", () => {
  const flat = (level: number) => new Uint8Array(100).fill(level);

  it("measures the mean absolute difference", () => {
    expect(meanAbsDiff(flat(10), flat(14))).toBe(4);
    expect(meanAbsDiff(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });

  it("calls the last frame a repeat when it matches frame 0 and the picture moves elsewhere", () => {
    expect(duplicateSeam(flat(50), flat(58), flat(120), flat(50))).toBe(0);
    expect(duplicateSeam(flat(50), flat(58), flat(120), flat(51))).toBeNull();
  });

  it("does not call a continuous seam, or a picture that never moves, a repeat", () => {
    expect(duplicateSeam(flat(50), flat(58), flat(120), flat(42))).toBeNull();
    expect(duplicateSeam(flat(50), flat(50), flat(50), flat(50))).toBeNull();
    expect(MOTION_DIFF).toBeGreaterThan(DUPLICATE_DIFF);
  });
});

describe("loop export (real ffmpeg)", () => {
  it("fades MP4 and MOV audio, not WebM (ADR 0039 decision 7)", async () => {
    const { plan } = await render(26, "mux", true);
    const fades = (container: "mp4" | "mov" | "webm") => muxStep({ ...plan, container }, null, "out").args.join(" ").includes("afade=t=in:curve=hsin");
    expect([fades("mov"), fades("mp4"), fades("webm")]).toEqual([true, true, false]);
  }, MEDIA_TIMEOUT);

  it(
    "fades the first and last 96 samples with a half sine over the cut fade, and leaves the middle alone",
    async () => {
      const plain = await audioSamples((await render(26, "plain", false)).output);
      const looped = await audioSamples((await render(26, "looped", true)).output);
      expect(looped.length).toBe(plain.length);
      expect(looped.length).toBe(Math.round((26 / 30) * 48_000));
      for (let i = FADE; i < plain.length - FADE; i++) expect(Math.abs(looped[i]! - plain[i]!)).toBeLessThan(1e-4);
      const strongest = (from: number) => {
        let best = from;
        for (let i = from; i < from + 16; i++) if (Math.abs(plain[i]!) > Math.abs(plain[best]!)) best = i;
        return best;
      };
      // hsin: gain 0.5 half way through the fade, both ends.
      const head = strongest(40);
      const tail = strongest(plain.length - FADE + 40);
      expect(Math.abs(plain[head]!)).toBeGreaterThan(0.02);
      expect(looped[head]! / plain[head]!).toBeCloseTo(0.5 - 0.5 * Math.cos((Math.PI * head) / FADE), 1);
      expect(looped[tail]! / plain[tail]!).toBeCloseTo(0.5 + 0.5 * Math.cos((Math.PI * (tail - (plain.length - FADE))) / FADE), 1);
      expect(Math.abs(looped[plain.length - 1]!)).toBeLessThan(1e-3);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "warns that the last frame repeats frame 0 when the cycle is one frame too long, and not at the right length",
    async () => {
      const long = await render(LEVELS + 1, "dup", true);
      const warning = await loopSeamWarning(ffmpeg, long.output, long.plan.frames, long.plan, join(dir, "seam-work-dup"));
      expect(warning).toMatch(/^Loop: the last frame \(25\) repeats frame 0 \(difference [\d.]+ of 255 at 160 px\)/);
      expect(warning).toContain("End the last key one frame earlier, or trim one frame");

      const exact = await render(LEVELS, "exact", true);
      expect(await loopSeamWarning(ffmpeg, exact.output, exact.plan.frames, exact.plan, join(dir, "seam-work-exact"))).toBeNull();

      // Frames counted wrongly (here one more than the file has) read four pictures out of line: no verdict.
      expect(await loopSeamWarning(ffmpeg, long.output, long.plan.frames + 1, long.plan, join(dir, "seam-work-count"))).toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it("leaves a file too short to judge alone", async () => {
    expect(await loopSeamWarning(ffmpeg, join(dir, "missing.mov"), 2, { width: 64, height: 48 }, join(dir, "seam-work-short"))).toBeNull();
  });
});

describe("render method with loop", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;

  beforeAll(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    const { imported } = await conn.request("asset.import", { cwd: project, files: [counter.path] });
    const track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    await conn.request("clip.add", { cwd: project, track, asset: imported[0]!.asset, start: 0, in: 0, out: (LEVELS + 1) / 30 + 0.001 });
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

  it("refuses a loop with a cover frame before queuing anything", async () => {
    await expect(conn.request("render", { cwd: project, loop: true, cover: { text: "hook" } })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { field: "loop" },
    });
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((job) => job.kind === "render")).toEqual([]);
  });

  it(
    "puts the repeated last frame in the job's warnings once the file is written, and a plain render has none",
    async () => {
      const result = await conn.request("render", { cwd: project, loop: true, out: join(project, "exports", "loop.mp4") });
      expect(result.warnings).toEqual([]);
      const job = await finished(result.job.id);
      expect(job).toMatchObject({ state: "done" });
      expect(job.warnings).toEqual([expect.stringMatching(/^Loop: the last frame \(25\) repeats frame 0/)]);

      const plain = await finished((await conn.request("render", { cwd: project, out: join(project, "exports", "plain.mp4") })).job.id);
      expect(plain).toMatchObject({ state: "done", warnings: [] });
    },
    MEDIA_TIMEOUT,
  );
});
