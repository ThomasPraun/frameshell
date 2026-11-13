import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline, gainAt } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeVoiceClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";
import { kicks, music } from "./music-fixture.js";

// `music.shape` through a real daemon. The film is a 12 s voice (speech at 2-4 s and 7-9 s) with a marker `slam` at 5 s and
// `end-card` at 11 s; the song is 26 s of kicks with a crash at 20.345 s, on its own audio track.
const MEDIA_TIMEOUT = 240_000;
const RATE = 16_000;
const CRASH = 20.345;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let voiceTrack: string;
let musicTrack: string;
let clip: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  mkdirSync(footage, { recursive: true });
  await makeVoiceClip(join(footage, "voice.mp4"), {
    own: [
      [2, 2, 440],
      [7, 2, 440],
    ],
    durationS: 12,
  });
  writeFileSync(join(footage, "song.wav"), wavOf(music(26, [...kicks(19.5), { at: CRASH, amplitude: 0.9, decay: 2.5 }], { rate: RATE }), RATE));
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "voice.mp4"), join(footage, "song.wav")] });
  voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  musicTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  clip = (await conn.request("clip.add", { cwd: project, track: musicTrack, asset: imported[1]!.asset, start: 0, in: 0, out: 26 })).changes.added[0]!;
  await conn.request("marker.add", { cwd: project, at: 5, label: "slam" });
  await conn.request("marker.add", { cwd: project, at: 11, label: "end-card" });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function clipOf(id: string): Promise<MediaClip> {
  const timeline = JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
  for (const track of timeline.tracks) {
    const found = (track as ClipTrack).clips?.find((candidate) => candidate.id === id);
    if (found) return found as MediaClip;
  }
  throw new Error(`no clip ${id}`);
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
const revision = async () => (await conn.request("timeline.show", { cwd: project, timeline: "main" })).revision;
const txOps = async (tx: string) => (await conn.request("history", { cwd: project })).transactions.find((entry) => entry.tx === tx)!.operations.map((op) => op.op);

describe("music.shape", () => {
  it(
    "plans a dry run from a marker, with the curve, and changes nothing",
    async () => {
      const before = await revision();
      const result = await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"], ending: "end-card", dryRun: true });
      expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, revision: before, clip, track: musicTrack, cleared: false, drops: [5], ending: 11, duck: null });
      expect(result.settings).toEqual({ drops: [5], ending: 11, lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2.5 });
      expect(result.steps.map((step) => step.id)).toEqual(["fade", "shape"]);
      expect(result.curve[0]).toEqual({ time: 4.54, dip: 0 });
      expect(result.curve.find((point) => point.time === 4.6)).toEqual({ time: 4.6, dip: 9 });
      expect(await revision()).toBe(before);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "writes music keys in one transaction that one revert undoes",
    async () => {
      const before = await revision();
      const result = await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"], ending: "end-card", fade: 2 });
      expect(result).toMatchObject({ applied: true, dryRun: false });
      expect(await txOps(result.tx!)).toEqual(["clip.set", "music.shape"]);
      const shaped = await clipOf(clip);
      expect(shaped.audio?.fadeInMs).toBe(5);
      expect(shaped.keys?.gain?.every((key) => key.auto === "music")).toBe(true);
      expect(gainAt(shaped, 3)).toBe(0);
      expect(gainAt(shaped, 4.8)).toBe(-9);
      expect(gainAt(shaped, 5.2)).toBe(-9);
      expect(gainAt(shaped, 6.5)).toBe(0);
      expect(gainAt(shaped, 13)).toBe(-60);
      expect(shaped.audio?.shape).toMatchObject({ drops: [5], ending: 11, fade: 2 });
      await conn.request("revert", { cwd: project, target: result.tx! });
      expect((await clipOf(clip)).keys).toBeUndefined();
      expect(await revision()).toBeGreaterThan(before);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps a fade in set by hand, and writes none on clear",
    async () => {
      await conn.request("clip.set", { cwd: project, clip, audioFadeInMs: 20 });
      const dry = await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"], dryRun: true });
      expect(dry.steps.map((step) => step.id)).toEqual(["shape"]);
      const result = await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"] });
      expect(await txOps(result.tx!)).toEqual(["music.shape"]);
      expect((await clipOf(clip)).audio?.fadeInMs).toBe(20);
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true });
      await conn.request("clip.set", { cwd: project, clip, audioFadeInMs: 0 });
      const cleared = await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true, dryRun: true });
      expect(cleared.steps.map((step) => step.id)).toEqual(["shape"]);
      expect((await clipOf(clip)).audio?.fadeInMs).toBeUndefined();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "runs again over its own keys, keeps a hand key, and clear removes only the music keys",
    async () => {
      await conn.request("clip.key", { cwd: project, clip, prop: "gain", time: 1, value: -3 });
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: [5] });
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: [8] });
      const shaped = await clipOf(clip);
      expect(shaped.keys!.gain!.find((key) => key.at === 1)).toEqual({ at: 1, value: -3 });
      expect(shaped.audio?.shape?.drops).toEqual([8]);
      expect(gainAt(shaped, 5)).toBeCloseTo(-3, 5);
      expect(gainAt(shaped, 8)).toBeCloseTo(-12, 5);
      const cleared = await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true });
      expect(cleared).toMatchObject({ cleared: true, settings: null, curve: [] });
      const after = await clipOf(clip);
      expect(after.keys!.gain).toEqual([{ at: 1, value: -3 }]);
      expect(after.audio?.shape).toBeUndefined();
      const nothing = await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true });
      expect(nothing).toMatchObject({ applied: false, tx: null });
      await conn.request("clip.key", { cwd: project, clip, prop: "gain", clear: true });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses an empty call, clear with times, a time off the clip, and a clip that is not music",
    async () => {
      const before = await revision();
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip }))).data).toMatchObject({ reason: "empty" });
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true, drop: [5] }))).data).toMatchObject({ reason: "clear" });
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: [90] }))).data).toMatchObject({ reason: "outside" });
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["nowhere"] }))).code).toBe(ErrorCode.InvalidOperation);
      const voice = (await conn.request("timeline.show", { cwd: project, timeline: "main" })).tracks.find((track) => track.id === voiceTrack)!.clips[0]!.id;
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip: voice, drop: [5] }))).data).toMatchObject({ reason: "not music" });
      expect((await rejection(conn.request("music.shape", { cwd: project, timeline: "main", clip: "c_nope", drop: [5] }))).code).toBe(ErrorCode.ClipNotFound);
      expect(await revision()).toBe(before);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "runs duck again over the shaped keys with the stored parameters, in the same transaction",
    async () => {
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], depth: 12 });
      const result = await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"] });
      expect(result.duck).toEqual({ under: [voiceTrack], rerun: true, parameters: "stored" });
      expect(await txOps(result.tx!)).toEqual(["music.shape", "track.duck"]);
      const both = await clipOf(clip);
      // Speech at 2-4 s ducks 12 dB; the hit at 5 s steps down 9 dB; each from the clip's own level.
      expect(gainAt(both, 3)).toBe(-12);
      expect(gainAt(both, 5)).toBeCloseTo(-9, 5);
      expect(gainAt(both, 6)).toBe(0);
      expect(both.keys!.gain!.some((key) => key.auto === "music")).toBe(true);
      expect(both.keys!.gain!.some((key) => key.auto === "duck")).toBe(true);
      expect(both.audio?.duck).toMatchObject({ depth: 12 });
      // A speech burst over a music hit: both dips hold where they overlap (the duck dips the music keys too).
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: [3] });
      expect(gainAt(await clipOf(clip), 3)).toBeLessThanOrEqual(-12);
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true });
      expect((await clipOf(clip)).keys!.gain!.every((key) => key.auto === "duck")).toBe(true);
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], depth: 1 });
      await conn.request("clip.key", { cwd: project, clip, prop: "gain", clear: true });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "is re-run by music.fit when it moves the clip, so the dips stay on the picture",
    async () => {
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, drop: ["slam"], ending: 10 });
      const dry = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card", dryRun: true });
      expect(dry.steps.map((step) => step.id)).toEqual(["intro", "shape"]);
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
      expect(await txOps(result.tx!)).toEqual(["clip.trim", "clip.move", "music.shape"]);
      const fitted = await clipOf(clip);
      // The clip now plays the file from about 9.3 s, but the hit is still at 5 s of the film.
      expect(fitted.in).toBeGreaterThan(9);
      expect(gainAt(fitted, 3)).toBe(0);
      expect(gainAt(fitted, 5)).toBe(-9);
      expect(gainAt(fitted, 6.5)).toBe(0);
      expect(gainAt(fitted, 10.5)).toBeCloseTo(-12, 5);
      expect(gainAt(fitted, 13)).toBe(-60);
      const kept = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 15, hit: CRASH, skip: ["shape"], dryRun: true });
      expect(kept.warnings.join(" ")).toContain("music keys");
      expect(kept.steps.map((step) => step.id)).not.toContain("shape");
      await conn.request("revert", { cwd: project, target: result.tx! });
      await conn.request("music.shape", { cwd: project, timeline: "main", clip, clear: true });
    },
    MEDIA_TIMEOUT,
  );
});
