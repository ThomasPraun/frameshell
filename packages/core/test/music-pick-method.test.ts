import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";
import { kicks, music } from "./music-fixture.js";

// `music.pick` through a real daemon, on tracks `music.candidates` placed (no `end`: the files play whole from 0).
// Three short synthetic songs at three levels: `Music 1` to `Music 3` in the order given, `Music 1` playing.
const MEDIA_TIMEOUT = 240_000;
const RATE = 16_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let assets: string[];
let candidatesTx: string;
let placed: Timeline["tracks"];

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  mkdirSync(footage, { recursive: true });
  const levels = [1, 0.5, 0.25];
  levels.forEach((level, index) => {
    const song = music(4, kicks(3.5).map((hit) => ({ ...hit, amplitude: hit.amplitude * level })), { rate: RATE });
    writeFileSync(join(footage, `song${index + 1}.wav`), wavOf(song, RATE));
  });
  const files = levels.map((_, index) => join(footage, `song${index + 1}.wav`));
  const { imported } = await conn.request("asset.import", { cwd: project, files });
  assets = imported.map((entry) => entry.asset);
  const result = await conn.request("music.candidates", { cwd: project, assets });
  candidatesTx = result.tx!;
  placed = (await timelineFile()).tracks;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function timelineFile(): Promise<Timeline> {
  return JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
}
const isMuted = (entry: Timeline["tracks"][number]) => (entry as ClipTrack).muted === true;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("music.pick", () => {
  it("starts from three candidate tracks, only the first playing", () => {
    expect(candidatesTx).toMatch(/^tx_/);
    expect(placed.map((entry) => [entry.name, isMuted(entry)])).toEqual([
      ["Music 1", false],
      ["Music 2", true],
      ["Music 3", true],
    ]);
  });

  it(
    "plans a dry run without writing",
    async () => {
      const before = (await timelineFile()).revision;
      const result = await conn.request("music.pick", { cwd: project, track: "Music 2", dryRun: true });
      expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, revision: before, keep: false });
      expect(result.chosen).toMatchObject({ name: "Music 2", asset: assets[1], renamedTo: "Music", unmuted: true });
      expect(result.removed.map((entry) => entry.name)).toEqual(["Music 1", "Music 3"]);
      expect(await timelineFile()).toMatchObject({ revision: before, tracks: placed });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps the chosen track unmuted as Music, removes the others in one transaction, and one revert brings them back",
    async () => {
      const result = await conn.request("music.pick", { cwd: project, track: "Music 2" });
      expect(result).toMatchObject({ dryRun: false, applied: true, warnings: [] });
      expect(result.tx).toMatch(/^tx_/);
      expect(result.chosen).toMatchObject({ track: placed[1]!.id, clip: (placed[1] as ClipTrack).clips[0]!.id, renamedTo: "Music", unmuted: true });
      expect(result.removed.map((entry) => entry.track)).toEqual([placed[0]!.id, placed[2]!.id]);

      const written = await timelineFile();
      expect(written.tracks).toHaveLength(1);
      const winner = written.tracks[0] as ClipTrack;
      expect(winner).toMatchObject({ id: placed[1]!.id, kind: "audio", name: "Music" });
      expect(winner.muted).toBeUndefined();
      // The clip is what candidates wrote: file, gain and the 5 ms entry fade.
      expect(winner.clips).toEqual((placed[1] as ClipTrack).clips);
      expect((winner.clips[0] as MediaClip).audio?.fadeInMs).toBe(5);

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.label).toBe("Music pick: Music 2");
      expect(tx.operations.map((op) => op.op)).toEqual(["track.set", "track.remove", "track.remove"]);

      await conn.request("revert", { cwd: project, target: result.tx! });
      expect((await timelineFile()).tracks).toEqual(placed);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "with keep mutes the others and leaves every track and clip in place, and revert undoes it",
    async () => {
      const result = await conn.request("music.pick", { cwd: project, track: placed[2]!.id, keep: true });
      expect(result).toMatchObject({ applied: true, keep: true, removed: [] });
      expect(result.muted.map((entry) => entry.name)).toEqual(["Music 1", "Music 2"]);
      const written = await timelineFile();
      expect(written.tracks.map((entry) => [entry.name, isMuted(entry)])).toEqual([
        ["Music 1", true],
        ["Music 2", true],
        ["Music", false],
      ]);
      expect(written.tracks.map((entry) => (entry as ClipTrack).clips)).toEqual(placed.map((entry) => (entry as ClipTrack).clips));
      await conn.request("revert", { cwd: project, target: result.tx! });
      expect((await timelineFile()).tracks).toEqual(placed);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "leaves a candidate with a speed of its own in place and says so, and keeps its own name next to an existing Music track",
    async () => {
      await conn.request("clip.set", { cwd: project, clip: (placed[2] as ClipTrack).clips[0]!.id, speed: 1.01 });
      const added = await conn.request("track.add", { cwd: project, kind: "audio", name: "Music" });
      const result = await conn.request("music.pick", { cwd: project, track: "Music 1" });
      expect(result.chosen).toMatchObject({ name: "Music 1", renamedTo: null, unmuted: false });
      expect(result.removed.map((entry) => entry.name)).toEqual(["Music 2"]);
      expect(result.left).toEqual([expect.objectContaining({ name: "Music 3", reason: "its clip was edited (speed)." })]);
      expect(result.warnings).toHaveLength(2);
      const written = await timelineFile();
      expect(written.tracks.map((entry) => entry.name)).toEqual(["Music 1", "Music 3", "Music"]);
      expect(written.tracks.find((entry) => entry.id === added.changes.added[0])).toBeDefined();
      await conn.request("revert", { cwd: project, target: result.tx! });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses what is not a candidate or has nothing to pick between, writing nothing",
    async () => {
      const before = (await timelineFile()).revision;
      const notCandidate = await rejection(conn.request("music.pick", { cwd: project, track: "Music" }));
      expect(notCandidate.code).toBe(ErrorCode.InvalidOperation);
      expect(notCandidate.data).toMatchObject({ reason: "not a candidate" });
      expect((await rejection(conn.request("music.pick", { cwd: project, track: "Music 9" }))).code).toBe(ErrorCode.TrackNotFound);
      expect((await rejection(conn.request("music.pick", { cwd: project, track: "" }))).code).toBe(ErrorCode.InvalidParams);
      expect((await timelineFile()).revision).toBe(before);
    },
    MEDIA_TIMEOUT,
  );
});
