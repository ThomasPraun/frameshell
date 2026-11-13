import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline, gainAt } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, measureLoudness, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstAudio, makeVoiceClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// `track.duck` with `level` through a real daemon: a voice with two bursts (440 Hz) and a steady 1 kHz bed. The bed's
// static gain is chosen from the EBU R128 loudness of the two files, then the dip is taken from that level.
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let voiceTrack: string;
let bedTrack: string;
let bedClip: string;
let voiceLufs: number;
let bedLufs: number;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeVoiceClip(join(footage, "voice.mp4"), {
    own: [
      [2, 2, 440],
      [7, 2, 440],
    ],
    durationS: 12,
  });
  await makeBurstAudio(join(footage, "bed.wav"), { durationS: 12, bursts: [[0, 12, 1000]] });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "voice.mp4"), join(footage, "bed.wav")] });
  voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  bedTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  bedClip = (await conn.request("clip.add", { cwd: project, track: bedTrack, asset: imported[1]!.asset, start: 0, in: 0, out: 12 })).changes.added[0]!;
  const { ffmpeg } = await mediaTools();
  voiceLufs = (await measureLoudness(ffmpeg, join(project, ...imported[0]!.asset.split("/"))))!.integrated!;
  bedLufs = (await measureLoudness(ffmpeg, join(project, ...imported[1]!.asset.split("/"))))!.integrated!;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function bed(): Promise<MediaClip> {
  const timeline = JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
  const track = timeline.tracks.find((candidate) => candidate.id === bedTrack) as ClipTrack;
  return track.clips.find((clip) => clip.id === bedClip) as MediaClip;
}

const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("track.duck level", () => {
  it(
    "sets the bed's static gain so its loudness sits `level` dB under the voice, then dips from that level, in one transaction",
    async () => {
      const result = await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack], depth: 6, level: 12 });
      // One voice file at no gain: its own loudness is the voice's, to the 0.1 dB the meter reports.
      expect(result.level).toMatchObject({ under: 12, voice: voiceLufs });
      expect(result.level!.target).toBe(Math.round((voiceLufs - 12) * 10) / 10);
      expect(result.level!.clips).toEqual([{ clip: bedClip, loudness: bedLufs, gain: Math.round((result.level!.target - bedLufs) * 10) / 10 }]);

      const clip = await bed();
      const gain = result.level!.clips[0]!.gain;
      expect(clip.audio?.gain).toBe(gain);
      // The bed now measures `level` dB under the voice (within the 0.1 dB steps of both readings).
      expect(Math.abs(bedLufs + gain - (voiceLufs - 12))).toBeLessThanOrEqual(0.15);
      // The dip is taken from that level: full level between the words, 6 dB under it while someone speaks.
      expect(gainAt(clip, 0)).toBeCloseTo(gain, 3);
      expect(gainAt(clip, 3)).toBeCloseTo(gain - 6, 3);
      expect(clip.audio?.duck).toMatchObject({ under: [voiceTrack], depth: 6, level: 12 });

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.operations.some((op) => op.op === "track.duck"))!;
      expect(tx.label).toBe(`Duck music: ${bedTrack} 12 dB under the voice`);
      expect(tx.operations.map((op) => op.op)).toEqual(["clip.set", "track.duck"]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "is repeatable, and leaves a clip with gain keys of its own alone, naming it",
    async () => {
      const first = await bed();
      await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack], depth: 6, level: 12 });
      expect(await bed()).toEqual(first);

      await conn.request("clip.key", { cwd: project, clip: bedClip, prop: "gain", time: 11.5, value: -1 });
      const result = await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack], level: 20 }).catch((error: unknown) => error as RpcError);
      // Its own gain keys: nothing can be set, and the refusal says why.
      expect((result as RpcError).code).toBe(ErrorCode.InvalidOperation);
      expect((result as RpcError).message).toContain("gain keys of its own");
      await conn.request("clip.key", { cwd: project, clip: bedClip, prop: "gain", time: 11.5, remove: true });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a level when there is no voice to measure, and writes nothing",
    async () => {
      const empty = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
      const before = (await conn.request("timeline.show", { cwd: project, timeline: "main" })).revision;
      const refused = await rejection(conn.request("track.duck", { cwd: project, track: bedTrack, under: [empty], level: 12 }));
      expect(refused.code).toBe(ErrorCode.InvalidOperation);
      expect(refused.data).toMatchObject({ field: "level" });
      expect((await conn.request("timeline.show", { cwd: project, timeline: "main" })).revision).toBe(before);
      await conn.request("track.remove", { cwd: project, track: empty });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "without level the gains stay and the settings are still kept for a later run",
    async () => {
      await conn.request("clip.set", { cwd: project, clip: bedClip, gain: -4 });
      const result = await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack], depth: 9 });
      expect(result.level).toBeNull();
      const clip = await bed();
      expect(clip.audio?.gain).toBe(-4);
      expect(clip.audio?.duck).toEqual({ under: [voiceTrack], depth: 9, attackMs: 40, releaseMs: 450, threshold: -38, gap: 0.6 });
      expect(gainAt(clip, 3)).toBe(-13);
    },
    MEDIA_TIMEOUT,
  );
});
