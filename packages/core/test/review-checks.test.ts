import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, type JobInfo, type ReviewMetrics, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `review` metrics of #457's sync, loop seam and delivery checks, on a real managed ffmpeg and tiny synthetic films.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let steps: string;

/** Seconds of 320x240 picture, each `[color, seconds]`, with an optional `aevalsrc` expression for the sound. */
async function makeFilm(path: string, colors: [string, number][], sound?: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const seconds = colors.reduce((sum, [, length]) => sum + length, 0);
  const inputs = colors.flatMap(([color, length]) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=30:d=${length}`]);
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...inputs,
    ...(sound ? ["-f", "lavfi", "-i", `aevalsrc='${sound}':s=48000:d=${seconds}`] : []),
    ...["-filter_complex", `${colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`, "-map", "[v]", ...(sound ? ["-map", `${colors.length}:a`, "-c:a", "aac"] : [])],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", path],
  ]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity, dirs: { dataDir: tempDir(), configDir: tempDir() } });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  steps = join(tempDir(), "steps.mp4");
  // The picture changes at 1.0 and 2.0 s.
  await makeFilm(steps, [["black", 1], ["white", 1], ["0x808080", 1]]);
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

const metricsOf = async (file: string, extra: Record<string, unknown> = {}): Promise<{ metrics: ReviewMetrics; warnings: string[] }> => {
  const result = await conn.request("review", { cwd: project, file, sheets: ["metrics"], ...extra });
  return { metrics: result.metrics!, warnings: result.warnings };
};

describe("review sync", () => {
  it(
    "scores the hits of a file's sound against its picture changes: one on the change, one late",
    async () => {
      // A 50 ms burst of a 1 kHz tone at 1.0 s (the picture goes white) and at 2.13 s (it goes gray at 2.0 s).
      const film = join(tempDir(), "bursts.mp4");
      await makeFilm(film, [["black", 1], ["white", 1], ["0x808080", 1]], "0.8*sin(2*PI*1000*t)*(between(t,1,1.05)+between(t,2.13,2.18))");
      const { metrics } = await metricsOf(film);
      expect(metrics.sync).toMatchObject({ source: "file", sounds: 2, excluded: 0 });
      expect(metrics.sync!.offsets.map((entry) => entry.verdict)).toEqual(["on", "late"]);
      expect(metrics.sync!.offsets[0]!.offset!).toBeLessThan(0.05);
      expect(metrics.sync!.offsets[1]!.offset!).toBeGreaterThan(0.09);
      expect(metrics.craft.filter((warning) => warning.check === "sync")).toEqual([expect.objectContaining({ message: expect.stringContaining("1 sound lands more than 75 ms after") })]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a file with no sound has no sync, and the tone of the loudness test has no hit to score",
    async () => {
      expect((await metricsOf(steps)).metrics.sync).toBeNull();
      const tone = join(tempDir(), "tone.mp4");
      await makeFilm(tone, [["black", 1], ["white", 1]], "0.5*sin(2*PI*1000*t)");
      expect((await metricsOf(tone)).metrics.sync).toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "scores the generated sounds placed on a timeline against its picture, and lists the cut that has no sound",
    async () => {
      const dir = tempDir();
      await conn.request("project.init", { dir });
      const { imported } = await conn.request("asset.import", { cwd: dir, files: [steps] });
      const video = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
      // Two clips of the footage: a cut at 1.5 s and the picture changes at 1.0 and 2.0 s.
      await conn.request("clip.add", { cwd: dir, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1.5 });
      await conn.request("clip.add", { cwd: dir, track: video, asset: imported[0]!.asset, start: 1.5, in: 1.5, out: 3 });
      await conn.request("sound.place", { cwd: dir, cues: [{ at: 1, kind: "click" }, { at: 2, kind: "thump" }, { at: 1.2, kind: "whoosh" }] });
      const { metrics } = (await conn.request("review", { cwd: dir, sheets: ["metrics"] })) as { metrics: ReviewMetrics };
      expect(metrics.sync).toMatchObject({ source: "takes", sounds: 2, excluded: 1, silentCuts: [1.5] });
      expect(metrics.sync!.offsets.map((entry) => entry.verdict)).toEqual(["on", "on"]);
      expect(metrics.sync!.hits).toBe(2);
      expect(metrics.craft.filter((warning) => warning.check === "sync")).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review loop seam", () => {
  it(
    "measures how far the last frame is from the first: a cut, a duplicate and a held picture",
    async () => {
      // Black, white, gray: the last frame is 128 levels from the first.
      const cut = (await metricsOf(steps)).metrics;
      expect(cut.seam).toMatchObject({ first: 0, verdict: "cut" });
      expect(cut.seam!.jump).toBeGreaterThan(100);
      // Black, white, black: the last frame repeats the first while the picture moves.
      const again = join(tempDir(), "again.mp4");
      await makeFilm(again, [["black", 1], ["white", 1], ["black", 1]]);
      expect((await metricsOf(again)).metrics.seam).toMatchObject({ verdict: "duplicate", jump: expect.any(Number) });
      // One gray picture: nothing moves, so nothing is held twice.
      const held = join(tempDir(), "held.mp4");
      await makeFilm(held, [["0x808080", 2]]);
      expect((await metricsOf(held)).metrics.seam).toMatchObject({ verdict: "continuous", jump: 0 });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "warns about the seam only for a film meant to repeat",
    async () => {
      const again = join(tempDir(), "again2.mp4");
      await makeFilm(again, [["black", 1], ["white", 1], ["black", 1]]);
      expect((await metricsOf(again)).metrics.craft.filter((warning) => warning.check === "loop-seam")).toEqual([]);
      const looped = (await metricsOf(again, { loop: true })).metrics.craft.filter((warning) => warning.check === "loop-seam");
      expect(looped).toEqual([expect.objectContaining({ message: expect.stringContaining("holds a frame twice") })]);
      const jump = (await metricsOf(steps, { loop: true })).metrics.craft.filter((warning) => warning.check === "loop-seam");
      expect(jump).toEqual([expect.objectContaining({ message: expect.stringContaining("jumps at the seam") })]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a range of one frame has no seam",
    async () => {
      expect((await metricsOf(steps, { from: 0, to: 0.03 })).metrics.seam).toBeNull();
    },
    MEDIA_TIMEOUT,
  );
});

describe("review delivery", () => {
  let exported: string;

  async function finished(id: string): Promise<JobInfo> {
    for (const deadline = Date.now() + 150_000; Date.now() < deadline; ) {
      const job = (await conn.request("job.list", { cwd: dir })).jobs.find((j) => j.id === id);
      if (job && job.state !== "queued" && job.state !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`job ${id} did not finish`);
  }
  let dir: string;

  beforeAll(async () => {
    dir = tempDir();
    await conn.request("project.init", { dir });
    const withSound = join(tempDir(), "with-sound.mp4");
    await makeFilm(withSound, [["black", 1], ["white", 1], ["0x808080", 1]], "0.5*sin(2*PI*440*t)");
    const { imported } = await conn.request("asset.import", { cwd: dir, files: [withSound] });
    const video = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
    await conn.request("clip.add", { cwd: dir, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 3 });
    exported = join(dir, "exports", "main.mp4");
    const job = await finished((await conn.request("render", { cwd: dir, preset: "youtube-1080p", out: exported })).job.id);
    expect(job.state).toBe("done");
  }, MEDIA_TIMEOUT);

  it(
    "checks an exported file against the plan of the preset it was made with: size, rate, length, codecs, loudness",
    async () => {
      const result = await conn.request("review", { cwd: dir, file: exported, preset: "youtube-1080p", sheets: ["metrics"] });
      const delivery = result.metrics!.delivery!;
      expect(delivery).toMatchObject({ timeline: "main", preset: "youtube-1080p", format: "16x9" });
      expect(delivery.bytes).toBeGreaterThan(1000);
      expect(delivery.checks.map((check) => [check.field, check.ok])).toEqual([
        ["width", true],
        ["height", true],
        ["fps", true],
        ["duration", true],
        ["codec", true],
        ["audio", true],
        ["loudness", true],
      ]);
      expect(result.metrics!.craft.filter((warning) => warning.check === "delivery")).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "names what differs when the file is checked against another preset, and does nothing without a preset",
    async () => {
      const wrong = await conn.request("review", { cwd: dir, file: exported, preset: "youtube-1440p", sheets: ["metrics"] });
      const failed = wrong.metrics!.delivery!.checks.filter((check) => !check.ok).map((check) => check.field);
      expect(failed).toEqual(expect.arrayContaining(["width", "height"]));
      expect(wrong.metrics!.craft.find((warning) => warning.check === "delivery")!.message).toContain("width is 1920, the plan says 2560");
      const plain = await conn.request("review", { cwd: dir, file: exported, sheets: ["metrics"] });
      expect(plain.metrics!.delivery).toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "says in warnings, and leaves the delivery out, when the preset does not exist",
    async () => {
      const result = await conn.request("review", { cwd: dir, file: exported, preset: "nope", sheets: ["metrics"] });
      expect(result.metrics!.delivery).toBeNull();
      expect(result.warnings.join("\n")).toContain("delivery: the file cannot be checked against the export plan");
    },
    MEDIA_TIMEOUT,
  );
});
