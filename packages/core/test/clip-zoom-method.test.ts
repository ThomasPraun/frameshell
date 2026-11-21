import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Clip, type PointerSample, type Timeline, pointerFileOf } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { makeMarkerClip } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// `clip.zoom` through a real daemon and managed ffmpeg, with a hand-written pointer track next to a synthetic screen.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let solo: DaemonConnection;
let project: string;
let track: string;

/** The pointer resting at (0.25, 0.5) from 2 to 4 s, darting about the rest of the 8 s. */
function samples(): PointerSample[] {
  return Array.from({ length: 160 }, (_, i): PointerSample => {
    const t = i / 20;
    return t >= 2 && t < 4 ? [t, 0.25, 0.5] : [t, (i * 0.37) % 1, 0.5];
  });
}

async function writePointer(asset: string, value: unknown): Promise<void> {
  await writeFile(join(project, ...pointerFileOf(asset).split("/")), JSON.stringify(value));
}

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
  });
  solo = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await solo.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const footage = tempDir();
  await makeMarkerClip(ffmpeg, join(footage, "screen.mp4"), { x: "100", durationS: 8 });
  await makeMarkerClip(ffmpeg, join(footage, "plain.mp4"), { x: "100", durationS: 4 });
  await solo.request("asset.import", { cwd: project, files: [join(footage, "screen.mp4"), join(footage, "plain.mp4")] });
  await mkdir(join(project, "assets"), { recursive: true });
  await writePointer("assets/screen.mp4", { version: 1, width: 1920, height: 1080, samples: samples() });
  track = (await solo.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  solo.close();
  await daemon.close();
});

async function clipOf(id: string): Promise<Clip> {
  const file = JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
  return file.tracks.flatMap((candidate) => ("clips" in candidate ? (candidate.clips as Clip[]) : [])).find((clip) => clip.id === id)!;
}

describe("clip.zoom", () => {
  it(
    "keys scale, x and y on the pointer's rest, in one revertible transaction",
    async () => {
      const id = (await solo.request("clip.add", { cwd: project, track, asset: "assets/screen.mp4", start: 10, in: 0, out: 8 })).changes.added[0]!;
      const result = await solo.request("clip.zoom", { cwd: project, clip: id, follow: "pointer", scale: 2 });
      expect(result).toMatchObject({ clip: id, pointer: "assets/.screen.pointer.json", scale: 2, rests: 1, zooms: 1, keys: 4, warnings: [] });
      expect(result.tx).not.toBeNull();
      const clip = (await clipOf(id)) as Clip & { keys: Record<string, { at: number; value: number; ease?: string }[]> };
      // Keys sit on the clip clock (source seconds): the push in starts 0.8 s before the rest, the ease back ends 0.9 s after (snapped to frames).
      expect(clip.keys.scale!.map((key) => [key.at, key.value])).toEqual([
        [1.2, 1],
        [1.7, 2],
        [4.367, 2],
        [4.867, 1],
      ]);
      // A quarter in from the left of a 16:9 picture in a 16:9 frame at 2x: moved right by half the frame.
      expect(clip.keys.x!.map((key) => key.value)).toEqual([0, 960, 960, 0]);
      expect(clip.keys.scale![0]!.ease).toBe("in-out");
      await solo.request("revert", { cwd: project, target: result.tx! });
      expect((await clipOf(id)) as { keys?: unknown }).not.toHaveProperty("keys");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "leaves a clip whose pointer never rests as it was, and refuses a clip with no pointer track",
    async () => {
      const id = (await solo.request("clip.add", { cwd: project, track, asset: "assets/screen.mp4", start: 30, in: 5, out: 8 })).changes.added[0]!;
      const result = await solo.request("clip.zoom", { cwd: project, clip: id, follow: "pointer" });
      expect(result).toMatchObject({ rests: 0, zooms: 0, keys: 0, tx: null, operations: [] });
      expect(result.warnings[0]).toMatch(/never rests/);
      const plain = (await solo.request("clip.add", { cwd: project, track, asset: "assets/plain.mp4", start: 40, in: 0, out: 4 })).changes.added[0]!;
      await expect(solo.request("clip.zoom", { cwd: project, clip: plain, follow: "pointer" })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringMatching(/no pointer track/),
      });
      await writePointer("assets/plain.mp4", { version: 1, width: 1, height: 1, samples: [[2, 0.5, 0.5], [1, 0.5, 0.5]] });
      await expect(solo.request("clip.zoom", { cwd: project, clip: plain, follow: "pointer" })).rejects.toMatchObject({
        message: expect.stringMatching(/time goes back/),
      });
    },
    MEDIA_TIMEOUT,
  );
});
