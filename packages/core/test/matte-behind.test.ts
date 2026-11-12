import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { makeMarkerClip } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// A track `behind` a plate through a real daemon, export and managed ffmpeg, with the stand-in matte (bright =
// subject): a red frame behind a white square moving on black shows the square over the red, black nowhere.
const MEDIA_TIMEOUT = 240_000;
let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let ffmpeg: string;

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    matteStandIn: true,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  ({ ffmpeg } = await mediaTools());
  const footage = tempDir();
  // A 60 px square on black, its left edge at 40 px at 0 s moving 80 px a second: centered at x 150 at 1 s.
  await makeMarkerClip(ffmpeg, join(footage, "mover.mp4"), { box: 60, durationS: 2, x: "40+80*t" });
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", "-y", join(footage, "word.png")]);
  await conn.request("asset.import", { cwd: project, files: ["mover.mp4", "word.png"].map((name) => join(footage, name)) });
  const plate = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  const word = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: plate, asset: "assets/mover.mp4", start: 0, in: 0, out: 2 });
  await conn.request("clip.add", { cwd: project, track: word, asset: "assets/word.png", start: 0, duration: 2 });
  await conn.request("track.set", { cwd: project, track: word, behind: plate });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function finished(id: string): Promise<JobInfo> {
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; ) {
    const job = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === id);
    if (job && job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

/** RGB of an image or of a video's frame at `at` seconds, scaled to 320x180. */
async function picture(file: string, at = 0): Promise<{ at(x: number, y: number): [number, number, number] }> {
  const bytes = await runBuffer(ffmpeg, [
    ...["-v", "error", "-ss", String(at), "-i", file, "-vf", "scale=320:180", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
  ]);
  return { at: (x, y) => [bytes[(y * 320 + x) * 3]!, bytes[(y * 320 + x) * 3 + 1]!, bytes[(y * 320 + x) * 3 + 2]!] };
}

const red = (rgb: [number, number, number]) => rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60;
const white = (rgb: [number, number, number]) => rgb.every((value) => value > 200);

describe("tracks behind a subject (ADR 0032)", () => {
  it(
    "render waits for the plate's matte, made in its own step, and lifts the subject over the track behind it",
    async () => {
      const result = await conn.request("render", { cwd: project, out: join(tempDir(), "behind.mp4") });
      expect(result.warnings).toEqual([]);
      const job = await finished(result.job.id);
      expect(job).toMatchObject({ state: "done", error: null });
      // Made by the render: the matte is there for `matte.prepare` at once.
      expect(await conn.request("matte.prepare", { cwd: project, asset: "assets/mover.mp4" })).toMatchObject({ cached: true, model: "stand-in" });
      // The square (the subject) is over the red word at 1 s, centered at x 150; the red shows elsewhere.
      const frame = await picture(result.output, 1);
      expect(white(frame.at(150, 90))).toBe(true);
      expect(red(frame.at(280, 90))).toBe(true);
      expect(red(frame.at(150, 20))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "frame captures the same composite, and without behind the word covers the subject",
    async () => {
      const out = join(tempDir(), "frame.png");
      await conn.request("frame", { cwd: project, at: 1, out });
      const lifted = await picture(out);
      expect(white(lifted.at(150, 90))).toBe(true);
      expect(red(lifted.at(40, 90))).toBe(true);
      const { tracks } = await conn.request("track.list", { cwd: project });
      const word = tracks.find((track) => track.behind !== undefined)!;
      await conn.request("track.set", { cwd: project, track: word.id, behind: null });
      await conn.request("frame", { cwd: project, at: 1, out });
      expect(red((await picture(out)).at(150, 90))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses behind in an image project", async () => {
    const image = tempDir();
    await conn.request("project.init", { dir: image, kind: "image" });
    await expect(conn.request("track.set", { cwd: image, track: "t_none", behind: "t_other" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "image project", field: "behind" }),
    });
  });
});
