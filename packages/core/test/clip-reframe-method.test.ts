import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Clip, type Timeline, clipInFormat } from "@frameshell/schema";
import { type Daemon, type FaceScanRequest, angleFaceKeys, reframePlacement, startDaemon, writeFaceScan } from "../src/index.js";
import { makeMarkerClip, markerDetector } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `clip.reframe` through a real daemon and managed ffmpeg, with a stand-in detector that takes a white square on
// black for the face (it sits left for 4 s, then right): nothing is downloaded.
const MEDIA_TIMEOUT = 180_000;
const SOURCE = { width: 320, height: 180 };
const PROJECT = { width: 1920, height: 1080 };
const FORMAT = { width: 9, height: 16 };

let daemon: Daemon;
let conn: DaemonConnection;
/** No terminal session: its operations never join another command's transaction. */
let solo: DaemonConnection;
let project: string;
let track: string;
let file: string;
const scans: FaceScanRequest[] = [];

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    faceScanner: (request) => {
      scans.push(request);
      return angleFaceKeys({ ...request, detect: markerDetector });
    },
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  solo = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const footage = tempDir();
  await makeMarkerClip(ffmpeg, join(footage, "talk.mp4"), { x: "if(lt(t,4),40,240)", durationS: 8 });
  await makeMarkerClip(ffmpeg, join(footage, "still.mp4"), { x: "100", durationS: 4 });
  await conn.request("asset.import", { cwd: project, files: [join(footage, "talk.mp4"), join(footage, "still.mp4")] });
  track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  file = join(project, "assets", "talk.mp4");
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  solo.close();
  await daemon.close();
});

async function timelineFile(): Promise<Timeline> {
  return JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
}

async function clipOf(id: string): Promise<Clip> {
  const found = (await timelineFile()).tracks.flatMap((candidate) => ("clips" in candidate ? (candidate.clips as Clip[]) : [])).find((clip) => clip.id === id);
  return found!;
}

/** Adds a clip of `asset` from source second `from` to `to`, starting at timeline second `start`. */
async function addClip(asset: string, start: number, from: number, to: number, extra: Record<string, unknown> = {}): Promise<string> {
  const added = await solo.request("clip.add", { cwd: project, track, asset, start, in: from, out: to, ...extra });
  return added.changes.added[0]!;
}

describe("clip.reframe", () => {
  it(
    "keys x where the face moves, scale static, on the clip's own stretch, in one revertible transaction",
    async () => {
      scans.length = 0;
      // The clip plays 2 to 8 s of the file from timeline second 10.
      const id = await addClip("assets/talk.mp4", 10, 2, 8);
      const result = await solo.request("clip.reframe", { cwd: project, clip: id });
      expect(methods["clip.reframe"].result.parse(result)).toEqual(result);
      expect(scans).toHaveLength(1);
      expect(scans[0]!.range).toEqual({ from: 2, to: 8 });
      expect(result).toMatchObject({ clip: id, format: "9x16", inFormat: null, follows: "face", samples: 12, faces: 12 });
      expect(result.keys).toBe(2);
      // Stage frame is 16:9 and no 9:16 format is declared: said once, with the way to frame one format alone.
      expect(result.warnings).toEqual([expect.stringContaining("frameshell format add 9x16")]);

      const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
      const left = reframePlacement({ source: SOURCE, project: PROJECT, format: FORMAT }, { x: 0.1875, y: 0.5 });
      const right = reframePlacement({ source: SOURCE, project: PROJECT, format: FORMAT }, { x: 0.8125, y: 0.5 });
      expect(clip.transform?.scale).toBe(left.scale);
      // Source seconds of the keys: the face stops at 3.5 s, glides, and is on the right at 4 s.
      expect(clip.keys?.x?.map((key) => key.at)).toEqual([3.5, 4]);
      expect(clip.keys?.x?.[0]).toMatchObject({ value: left.x, ease: "in-out" });
      expect(clip.keys?.x?.[1]).toEqual({ at: 4, value: right.x });
      // Height only just covers the frame, so y never moves: static, no keys.
      expect(clip.keys?.y).toBeUndefined();
      expect(clip.transform?.y).toBe(left.y);

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.label).toBe("Reframe talk");
      expect(tx.operations.map((op) => op.op)).toEqual(["clip.set", "clip.key", "clip.key"]);
      expect(tx.operations.map((op) => op.id)).toEqual(result.operations);

      const { jobs } = await solo.request("job.list", { cwd: project });
      expect(jobs.filter((job) => job.kind === "faces").at(-1)).toMatchObject({ asset: "assets/talk.mp4", state: "done" });

      await solo.request("revert", { cwd: project, target: result.tx! });
      const reverted = await clipOf(id);
      expect(reverted).not.toHaveProperty("keys");
      expect(reverted).not.toHaveProperty("transform");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "writes a static placement and no keys for a face that never moves",
    async () => {
      const id = await addClip("assets/still.mp4", 30, 0, 4);
      const result = await solo.request("clip.reframe", { cwd: project, clip: id, format: "4:5" });
      expect(result).toMatchObject({ format: "4x5", follows: "face", keys: 0 });
      const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
      expect(clip).not.toHaveProperty("keys");
      const expected = reframePlacement({ source: SOURCE, project: PROJECT, format: { width: 4, height: 5 } }, { x: 0.375, y: 0.5 });
      expect(clip.transform).toEqual({ scale: expected.scale, x: expected.x, y: expected.y });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "replaces the framing a clip had, keys included, and says so",
    async () => {
      const id = await addClip("assets/talk.mp4", 40, 0, 8, { transform: { x: 50, scale: 1.2 } });
      await solo.request("clip.key", { cwd: project, clip: id, prop: "y", time: 41, value: 20 });
      await solo.request("clip.key", { cwd: project, clip: id, prop: "opacity", time: 41, value: 0.5 });
      const result = await solo.request("clip.reframe", { cwd: project, clip: id });
      expect(result.warnings).toContainEqual(expect.stringContaining("replaced"));
      const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
      expect(clip.keys?.y).toBeUndefined();
      expect(clip.keys?.x).toHaveLength(2);
      // Other properties are left alone.
      expect(clip.keys?.opacity).toHaveLength(1);
      expect(clip.transform?.scale).toBeGreaterThan(3);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "with an anchor, places the picture at that horizontal point without looking for faces",
    async () => {
      scans.length = 0;
      const id = await addClip("assets/talk.mp4", 60, 0, 8);
      const result = await solo.request("clip.reframe", { cwd: project, clip: id, anchor: 0.25 });
      expect(scans).toEqual([]);
      expect(result).toMatchObject({ follows: "anchor", samples: 0, faces: 0, keys: 0 });
      const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
      const expected = reframePlacement({ source: SOURCE, project: PROJECT, format: FORMAT }, { x: 0.25, y: 0.5 });
      expect(clip.transform).toEqual({ scale: expected.scale, x: expected.x, y: expected.y });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "follows a person's face from the cached people scan, without detecting",
    async () => {
      scans.length = 0;
      const id = await addClip("assets/talk.mp4", 80, 0, 8);
      const hash = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
      // Ana's face: left until 4 s, then right (a box every half second).
      const boxes = Array.from({ length: 16 }, (_, i) => ({ time: i / 2, x: i / 2 < 4 ? 0.1875 : 0.8125, y: 0.5, width: 0.12, height: 0.2, score: 0.9 }));
      await writeFaceScan(project, hash, { width: 512, height: 288, samples: 16, tracks: [{ id: "t1", start: 0, end: 7.5, boxes, embeddings: [] }] });
      await conn.request("people.add", { cwd: project, name: "Ana" });
      await conn.request("people.link", { cwd: project, person: "Ana", face: { asset: "assets/talk.mp4", at: 1, x: 0.1875, y: 0.5 } });
      const result = await solo.request("clip.reframe", { cwd: project, clip: id, person: "Ana" });
      expect(scans).toEqual([]);
      expect(result).toMatchObject({ follows: "person", faces: 16, keys: 2 });
      const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
      expect(clip.keys?.x?.map((key) => key.at)).toEqual([3.5, 4]);

      const unscanned = await addClip("assets/still.mp4", 90, 0, 4);
      await expect(solo.request("clip.reframe", { cwd: project, clip: unscanned, person: "Ana" })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringContaining("people scan assets/still.mp4"),
      });
      await expect(solo.request("clip.reframe", { cwd: project, clip: id, person: "Zoe" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "in review mode, one proposal that is ready once the run ends, also without a terminal session",
    async () => {
      const id = await addClip("assets/talk.mp4", 100, 0, 8);
      const app = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
      try {
        await app.request("review.set", { cwd: project, enabled: true });
        const before = await clipOf(id);
        const result = await solo.request("clip.reframe", { cwd: project, clip: id });
        expect(await clipOf(id)).toEqual(before);
        const { proposal } = await solo.request("proposal.status", { cwd: project });
        expect(proposal).toMatchObject({ tx: result.tx, state: "ready", operations: result.operations.length });
        await app.request("proposal.reject", { cwd: project, tx: result.tx! });
      } finally {
        await app.request("review.set", { cwd: project, enabled: false });
        app.close();
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "leaves a clip alone, with a warning, when no face is found",
    async () => {
      const dark = tempDir();
      const { ffmpeg } = await mediaTools();
      await makeMarkerClip(ffmpeg, join(dark, "empty.mp4"), { x: "-100", durationS: 3 });
      await conn.request("asset.import", { cwd: project, files: [join(dark, "empty.mp4")] });
      const id = await addClip("assets/empty.mp4", 120, 0, 3);
      const result = await solo.request("clip.reframe", { cwd: project, clip: id });
      expect(result).toMatchObject({ faces: 0, keys: 0, tx: null, placement: null, operations: [] });
      expect(result.warnings).toEqual([expect.stringContaining("--anchor")]);
      expect(await clipOf(id)).not.toHaveProperty("transform");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "frames a sideways recording as the picture plays: rotation metadata applied before anything is measured",
    async () => {
      const { ffmpeg } = await mediaTools();
      const dir = tempDir();
      await makeMarkerClip(ffmpeg, join(dir, "flat.mp4"), { x: "100", durationS: 3 });
      // 320x180 frames displayed turned a quarter: a 180x320 portrait picture.
      await run(ffmpeg, ["-v", "error", "-y", "-display_rotation", "90", "-i", join(dir, "flat.mp4"), "-c", "copy", join(dir, "phone.mp4")]);
      await conn.request("asset.import", { cwd: project, files: [join(dir, "phone.mp4")] });
      const id = await addClip("assets/phone.mp4", 160, 0, 3);
      scans.length = 0;
      const result = await solo.request("clip.reframe", { cwd: project, clip: id });
      expect(scans[0]).toMatchObject({ width: 180, height: 320 });
      expect(result.faces).toBeGreaterThan(0);
      // A portrait picture already covers 9:16: only the headroom.
      expect(result.placement!.scale).toBeLessThan(1.003);
      expect(Math.abs(result.placement!.x)).toBeLessThan(2);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "with a declared format's id, frames the clip in that format's override only, and keeps the clip's own framing",
    async () => {
      await conn.request("format.add", { cwd: project, id: "9x16" });
      await conn.request("format.add", { cwd: project, id: "web-4x5", width: 1080, height: 1350 });
      try {
        const id = await addClip("assets/talk.mp4", 180, 2, 8, { transform: { x: 30, scale: 1.1 } });
        await solo.request("clip.key", { cwd: project, clip: id, prop: "y", time: 181, value: 12 });
        // A key of the override that the reframe replaces.
        await solo.request("clip.key", { cwd: project, clip: id, prop: "scale", time: 181, value: 2, format: "9x16" });
        const result = await solo.request("clip.reframe", { cwd: project, clip: id });
        expect(result).toMatchObject({ format: "9x16", inFormat: "9x16", follows: "face", keys: 2 });
        expect(result.warnings).toEqual([expect.stringContaining("in format 9x16")]);
        const clip = (await clipOf(id)) as Extract<Clip, { type: "media" }>;
        // The clip itself, so the primary, is as it was.
        expect(clip.transform).toEqual({ x: 30, scale: 1.1 });
        expect(clip.keys?.y).toHaveLength(1);
        const left = reframePlacement({ source: SOURCE, project: PROJECT, format: FORMAT }, { x: 0.1875, y: 0.5 });
        const override = clip.formats?.["9x16"];
        expect(override?.transform).toEqual({ scale: left.scale, x: left.x, y: left.y });
        expect(override?.keys?.scale).toBeUndefined();
        expect(override?.keys?.x?.map((key) => key.at)).toEqual([3.5, 4]);
        expect(clipInFormat(clip, "9x16").keys?.y).toBeUndefined();
        const history = await conn.request("history", { cwd: project });
        expect(history.transactions.find((entry) => entry.tx === result.tx)!.operations.map((op) => op.op)).toEqual(["clip.key", "clip.set", "clip.key", "clip.key"]);
        await solo.request("revert", { cwd: project, target: result.tx! });
        expect((await clipOf(id)).formats?.["9x16"]).toEqual({ keys: { scale: [expect.objectContaining({ value: 2 })] } });

        // A custom format frames for its own aspect; `4:5` is the aspect and frames the clip itself.
        const custom = await solo.request("clip.reframe", { cwd: project, clip: id, anchor: 0.5, format: "web-4x5" });
        expect(custom).toMatchObject({ format: "4x5", inFormat: "web-4x5" });
        const square = reframePlacement({ source: SOURCE, project: PROJECT, format: { width: 4, height: 5 } }, { x: 0.5, y: 0.5 });
        expect((await clipOf(id)).formats?.["web-4x5"]?.transform).toEqual({ scale: square.scale, x: square.x, y: square.y });
        const aspect = await solo.request("clip.reframe", { cwd: project, clip: id, anchor: 0.5, format: "4:5" });
        expect(aspect).toMatchObject({ format: "4x5", inFormat: null });
        expect(aspect.warnings).toContainEqual(expect.stringContaining("reframe with format web-4x5"));
        expect((await clipOf(id)).transform).toEqual({ scale: square.scale, x: square.x, y: square.y });
      } finally {
        await conn.request("format.remove", { cwd: project, id: "web-4x5" });
        await conn.request("format.remove", { cwd: project, id: "9x16" });
      }
    },
    MEDIA_TIMEOUT,
  );

  it("refuses what it cannot frame", async () => {
    const id = await addClip("assets/talk.mp4", 140, 0, 2);
    await expect(solo.request("clip.reframe", { cwd: project, clip: id, format: "vertical" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("9x16"),
    });
    await expect(solo.request("clip.reframe", { cwd: project, clip: id, person: "Ana", anchor: 0.5 })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(solo.request("clip.reframe", { cwd: project, clip: "c_nope" })).rejects.toMatchObject({ code: ErrorCode.ClipNotFound });
  });
});
