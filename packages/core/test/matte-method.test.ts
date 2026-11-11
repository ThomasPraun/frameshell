import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { makeMarkerClip } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// `matte.prepare` through a real daemon and managed ffmpeg with the stand-in model (bright = subject):
// a white square moving on black must come out as a white square moving on black. Nothing is downloaded.
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
  // A 60 px square, its left edge at 40 px at 0 s moving 80 px a second.
  await makeMarkerClip(ffmpeg, join(footage, "mover.mp4"), { box: 60, durationS: 2, x: "40+80*t" });
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "-y", join(footage, "logo.png")]);
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1", "-y", join(footage, "tone.wav")]);
  await conn.request("asset.import", { cwd: project, files: ["mover.mp4", "logo.png", "tone.wav"].map((name) => join(footage, name)) });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

/** Luma of frame `n` of the matte at `rel`, one byte per pixel. */
async function matteFrame(rel: string, n: number, width: number, height: number): Promise<{ at(x: number, y: number): number }> {
  const bytes = await runBuffer(ffmpeg, [
    ...["-v", "error", "-i", join(project, ...rel.split("/")), "-vf", `select=eq(n\\,${n}),format=gray`],
    ...["-frames:v", "1", "-f", "rawvideo", "-"],
  ]);
  expect(bytes.length).toBe(width * height);
  return { at: (x, y) => bytes[y * width + x]! };
}

describe("matte.prepare", () => {
  it(
    "mattes every proxy frame of a video once per content, white where the subject is, and runs as a matte job",
    async () => {
      const progress: string[] = [];
      const result = await conn.request("matte.prepare", { cwd: project, asset: "assets/mover.mp4" }, { onProgress: (update) => progress.push(update.stage ?? "") });
      expect(methods["matte.prepare"].result.parse(result)).toEqual(result);
      expect(result).toMatchObject({ asset: "assets/mover.mp4", model: "stand-in", size: { width: 320, height: 180 }, fps: 30, frames: 60, cached: false });
      expect(result.matte).toMatch(/^\.frameshell\/cache\/mattes\/[0-9a-f]{20}-m1-[0-9a-f]{8}\.mp4$/);
      expect(existsSync(join(project, ...result.matte.split("/")))).toBe(true);
      expect(existsSync(join(project, ...result.matte.replace(/\.mp4$/, ".json").split("/")))).toBe(true);
      expect(progress).toContain("matte");

      // The square's center at 0 s (x 70, y 90) and at the last frame (1.97 s: x about 227), and far from both.
      const first = await matteFrame(result.matte, 0, 320, 180);
      expect(first.at(70, 90)).toBeGreaterThan(245);
      expect(first.at(250, 90)).toBeLessThan(10);
      expect(first.at(70, 20)).toBeLessThan(10);
      const last = await matteFrame(result.matte, 59, 320, 180);
      expect(last.at(226, 90)).toBeGreaterThan(245);
      expect(last.at(70, 90)).toBeLessThan(10);

      const jobs = await conn.request("job.list", { cwd: project });
      expect(jobs.jobs.filter((job) => job.kind === "matte")).toEqual([expect.objectContaining({ asset: "assets/mover.mp4", state: "done", step: null })]);

      const again = await conn.request("matte.prepare", { cwd: project, asset: join(project, "assets", "mover.mp4") });
      expect(again).toEqual({ ...result, cached: true });
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a still picture, audio, a missing file and an image project", async () => {
    for (const asset of ["assets/logo.png", "assets/tone.wav"]) {
      await expect(conn.request("matte.prepare", { cwd: project, asset })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: expect.objectContaining({ reason: "not a video" }),
      });
    }
    await expect(conn.request("matte.prepare", { cwd: project, asset: "assets/none.mp4" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    const image = tempDir();
    await conn.request("project.init", { dir: image, kind: "image" });
    await expect(conn.request("matte.prepare", { cwd: image, asset: "assets/none.mp4" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "image project" }),
    });
  });

  it(
    "gc keeps the matte while its asset is there and sweeps it once the asset is gone",
    async () => {
      const { matte } = await conn.request("matte.prepare", { cwd: project, asset: "assets/mover.mp4" });
      const kept = await conn.request("gc", { cwd: project, dryRun: true });
      expect(kept.removed.filter((entry) => entry.kind === "matte")).toEqual([]);
      rmSync(join(project, "assets", "mover.mp4"), { force: true });
      const swept = await conn.request("gc", { cwd: project, dryRun: false });
      const stem = matte.replace(/\.mp4$/, "");
      expect(swept.removed.filter((entry) => entry.kind === "matte").map((entry) => entry.path)).toEqual([`${stem}.json`, `${stem}.mp4`]);
      expect(existsSync(join(project, ...matte.split("/")))).toBe(false);
    },
    MEDIA_TIMEOUT,
  );
});
