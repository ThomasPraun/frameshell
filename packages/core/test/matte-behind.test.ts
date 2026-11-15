import { existsSync, readFileSync } from "node:fs";
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
let footage: string;

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
  footage = tempDir();
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

// Strict: a black matte read as limited range (alpha 16/255) would let the plate's black dim the red to about 240.
const red = (rgb: [number, number, number]) => rgb[0] > 245 && rgb[1] < 20 && rgb[2] < 20;
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

  it(
    "matte.status queues the matte of each plate the preview draws a subject of, and reports it ready",
    async () => {
      const fresh = tempDir();
      await conn.request("project.init", { dir: fresh });
      await conn.request("asset.import", { cwd: fresh, files: ["mover.mp4", "word.png"].map((name) => join(footage, name)) });
      const plate = (await conn.request("track.add", { cwd: fresh, kind: "video" })).changes.added[0]!;
      const word = (await conn.request("track.add", { cwd: fresh, kind: "video" })).changes.added[0]!;
      await conn.request("clip.add", { cwd: fresh, track: plate, asset: "assets/mover.mp4", start: 0, in: 0, out: 2 });
      await conn.request("clip.add", { cwd: fresh, track: word, asset: "assets/word.png", start: 0, duration: 2 });
      expect((await conn.request("matte.status", { cwd: fresh, timeline: "main" })).mattes).toEqual([]);
      await conn.request("track.set", { cwd: fresh, track: word, behind: plate });
      const states: string[] = [];
      let found = (await conn.request("matte.status", { cwd: fresh, timeline: "main" })).mattes;
      for (const deadline = Date.now() + 180_000; found[0]?.state !== "ready" && found[0]?.state !== "failed" && Date.now() < deadline; ) {
        states.push(found[0]!.state);
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = (await conn.request("matte.status", { cwd: fresh, timeline: "main" })).mattes;
      }
      // The read never makes it in line: the first answer is a pending state.
      expect(states[0]).toMatch(/^(waiting|queued|making)$/);
      const matte = expect.stringMatching(/^\.frameshell\/cache\/mattes\/.+\.mp4$/);
      expect(found).toEqual([{ asset: "assets/mover.mp4", state: "ready", matte, progress: 1, job: null, error: null }]);
      const jobs = (await conn.request("job.list", { cwd: fresh })).jobs.filter((job) => job.kind === "matte");
      expect(jobs).toEqual([expect.objectContaining({ state: "done", asset: "assets/mover.mp4" })]);
      // One matte, never made twice: `matte.prepare` finds the same file.
      expect(await conn.request("matte.prepare", { cwd: fresh, asset: "assets/mover.mp4" })).toMatchObject({ cached: true, matte: found[0]!.matte });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a plate above 1080p: the preview's matte is proxy size, export makes and draws through a full-size one",
    async () => {
      const fresh = tempDir();
      await conn.request("project.init", { dir: fresh });
      // A 480 px square on 2560x1440 black, its left edge still at 600 px.
      await makeMarkerClip(ffmpeg, join(footage, "big.mp4"), { width: 2560, height: 1440, box: 480, durationS: 1, x: "600" });
      await conn.request("asset.import", { cwd: fresh, files: ["big.mp4", "word.png"].map((name) => join(footage, name)) });
      const plate = (await conn.request("track.add", { cwd: fresh, kind: "video" })).changes.added[0]!;
      const word = (await conn.request("track.add", { cwd: fresh, kind: "video" })).changes.added[0]!;
      await conn.request("clip.add", { cwd: fresh, track: plate, asset: "assets/big.mp4", start: 0, in: 0, out: 1 });
      await conn.request("clip.add", { cwd: fresh, track: word, asset: "assets/word.png", start: 0, duration: 1 });
      await conn.request("track.set", { cwd: fresh, track: word, behind: plate });
      let found = (await conn.request("matte.status", { cwd: fresh, timeline: "main" })).mattes;
      for (const deadline = Date.now() + 180_000; found[0]?.state !== "ready" && found[0]?.state !== "failed" && Date.now() < deadline; ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = (await conn.request("matte.status", { cwd: fresh, timeline: "main" })).mattes;
      }
      expect(found[0]).toMatchObject({ state: "ready" });
      const proxyMatte = found[0]!.matte!;
      const fullMatte = proxyMatte.replace(/\.mp4$/, ".full.mp4");
      expect(existsSync(join(fresh, ...fullMatte.split("/")))).toBe(false);

      // The square spans x 600-1080 of 2560 (75-135 of 320), centered at y 90.
      const out = join(tempDir(), "big.png");
      await conn.request("frame", { cwd: fresh, at: 0.5, out });
      expect(existsSync(join(fresh, ...fullMatte.split("/")))).toBe(true);
      const lifted = await picture(out);
      expect(white(lifted.at(105, 90))).toBe(true);
      expect(red(lifted.at(280, 90))).toBe(true);
      expect(red(lifted.at(105, 20))).toBe(true);

      const prepared = await conn.request("matte.prepare", { cwd: fresh, asset: "assets/big.mp4" });
      expect(prepared).toMatchObject({ cached: true, matte: proxyMatte, size: { width: 960, height: 540 }, full: { matte: fullMatte, size: { width: 2560, height: 1440 } } });
      // Frame 15 (0.5 s), row 720: the full-size matte steps from 0 to 255 between two pixels at both edges of the
      // square; the proxy-size matte scaled up as export used to scale it leaves soft pixels there.
      const row = async (file: string, filter: string) => {
        const bytes = await runBuffer(ffmpeg, ["-v", "error", "-i", join(fresh, ...file.split("/")), "-vf", `select=eq(n\\,15),${filter}`, "-frames:v", "1", "-f", "rawvideo", "-"]);
        expect(bytes.length).toBe(2560 * 1440);
        return bytes.subarray(720 * 2560, 721 * 2560);
      };
      const full = await row(fullMatte, "format=gray");
      const scaled = await row(proxyMatte, "extractplanes=y,scale=2560:1440,format=gray");
      expect([full[599]! < 10, full[600]! > 245, full[1079]! > 245, full[1080]! < 10]).toEqual([true, true, true, true]);
      const soft = (line: Uint8Array) => line.filter((v) => v > 10 && v < 245).length;
      expect(soft(full)).toBe(0);
      expect(soft(scaled)).toBeGreaterThan(0);
      // Same frames as the proxy: 1 s at the project's 30 fps.
      const record = JSON.parse(readFileSync(join(fresh, ...fullMatte.replace(/\.mp4$/, ".json").split("/")), "utf8")) as { frames: number };
      expect([record.frames, prepared.frames]).toEqual([30, 30]);
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
