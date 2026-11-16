import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, LOUDNESS_DIR, measureLoudness, startDaemon } from "../src/index.js";
import { gainFor } from "../src/media/loudness-plan.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeVoiceClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// `duck --level` over the part of the file a clip plays, `--level style`, and the level set again when `music.fit` and
// `music.shape` change the clip. The music is 20 s of a 440 Hz tone, 8 dB louder from 10 s on (the quiet half stays above the R128 relative gate); the voice has two bursts.
const MEDIA_TIMEOUT = 240_000;
const RATE = 16_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let ffmpeg: string;
let voiceTrack: string;
let musicTrack: string;
let musicAsset: string;
let voiceLufs: number;

const timelineFile = (): Timeline => JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as Timeline;
const clipOf = (id: string): MediaClip => (timelineFile().tracks.find((track) => track.id === musicTrack) as ClipTrack).clips.find((clip) => clip.id === id) as MediaClip;
const partLufs = async (start: number, end: number) => (await measureLoudness(ffmpeg, join(project, ...musicAsset.split("/")), undefined, undefined, { start, end }))!.integrated!;

async function addMusic(): Promise<string> {
  return (await conn.request("clip.add", { cwd: project, track: musicTrack, asset: musicAsset, start: 0, in: 0, out: 20 })).changes.added[0]!;
}
async function clearMusic(): Promise<void> {
  for (const track of timelineFile().tracks.filter((candidate) => candidate.id === musicTrack) as ClipTrack[]) {
    for (const clip of track.clips) await conn.request("clip.remove", { cwd: project, clip: clip.id });
  }
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  ffmpeg = (await mediaTools()).ffmpeg;
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
  const samples = new Float32Array(20 * RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = (i < 10 * RATE ? 0.2 : 0.5) * Math.sin((2 * Math.PI * 1000 * i) / RATE);
  writeFileSync(join(footage, "halves.wav"), wavOf(samples, RATE));
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "voice.mp4"), join(footage, "halves.wav")] });
  musicAsset = imported[1]!.asset;
  voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  musicTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  voiceLufs = (await measureLoudness(ffmpeg, join(project, ...imported[0]!.asset.split("/"))))!.integrated!;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("duck --level over the part of the file that plays", () => {
  it(
    "sets the gain from the loudness of the played part, once per part",
    async () => {
      const clip = (await conn.request("clip.add", { cwd: project, track: musicTrack, asset: musicAsset, start: 0, in: 10, out: 20 })).changes.added[0]!;
      const result = await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: 12 });
      const loud = await partLufs(10, 20);
      const whole = (await measureLoudness(ffmpeg, join(project, ...musicAsset.split("/"))))!.integrated!;
      expect(whole).toBeLessThan(loud - 1.5);
      expect(result.level).toMatchObject({ under: 12, source: "given", voice: voiceLufs, clips: [{ clip, loudness: loud }] });
      // The loud half is brought 12 dB under the voice: the file's average would have turned it down far less.
      expect(clipOf(clip).audio?.gain).toBe(gainFor(loud, result.level!.target));
      expect(Math.abs(loud + clipOf(clip).audio!.gain! - (voiceLufs - 12))).toBeLessThanOrEqual(0.15);

      // The part was measured once and kept next to the whole-file readings.
      const names = readdirSync(join(project, ...LOUDNESS_DIR.split("/")));
      expect(names.filter((name) => name.includes("-r10000-20000"))).toHaveLength(1);
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: 12 });
      expect(readdirSync(join(project, ...LOUDNESS_DIR.split("/")))).toEqual(names);
      await clearMusic();
    },
    MEDIA_TIMEOUT,
  );
});

describe("duck --level style", () => {
  it(
    "takes the project's sound.musicUnderVoice, keeps the number it came to and says where it came from",
    async () => {
      const clip = await addMusic();
      // No style file: the default, 12 dB.
      const byDefault = await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: "style" });
      expect(byDefault.level).toMatchObject({ under: 12, source: "style" });
      expect(clipOf(clip).audio?.duck?.level).toBe(12);

      await conn.request("style.set", { cwd: project, path: "sound.musicUnderVoice", value: 9 });
      const styled = await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: "style" });
      expect(styled.level).toMatchObject({ under: 9, source: "style", voice: voiceLufs });
      expect(styled.level!.target).toBe(Math.round((voiceLufs - 9) * 10) / 10);
      expect(clipOf(clip).audio?.duck?.level).toBe(9);
      // A number is a number, whatever the style says.
      const given = await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: 15 });
      expect(given.level).toMatchObject({ under: 15, source: "given" });
      await clearMusic();
    },
    MEDIA_TIMEOUT,
  );
});

describe("the level set again", () => {
  it(
    "after music.fit moves the part a clip plays, and after music.shape, with the keys taken from the new level",
    async () => {
      const clip = await addMusic();
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: 12 });
      const first = clipOf(clip).audio!.gain!;
      const target = Math.round((voiceLufs - 12) * 10) / 10;
      expect(first).toBe(gainFor(await partLufs(0, 20), target));

      // The final hit at 19 s of the file lands at 10 s: the first 9 s of the file are dropped, the loud half is most of what plays.
      const fitted = await conn.request("music.fit", { cwd: project, clip, end: 10, hit: 19 });
      expect(fitted.after.in).toBe(9);
      const afterFit = clipOf(clip);
      expect(afterFit.audio!.gain).toBe(gainFor(await partLufs(9, 20), target));
      expect(afterFit.audio!.gain).not.toBe(first);
      expect(afterFit.audio?.duck).toMatchObject({ under: [voiceTrack], level: 12 });
      expect(afterFit.keys?.gain?.some((key) => key.auto === "duck")).toBe(true);
      expect(fitted.warnings.join(" ")).toContain("set again from level 12 dB");

      // Shaping writes music keys from the clip's level; the level is set again first and stays as it was (nothing moved).
      const shaped = await conn.request("music.shape", { cwd: project, clip, drop: [5] });
      expect(clipOf(clip).audio!.gain).toBe(afterFit.audio!.gain);
      expect(clipOf(clip).keys?.gain?.some((key) => key.auto === "music" || key.baseAuto === "music")).toBe(true);
      expect(shaped.warnings.join(" ")).toContain("set again from level 12 dB");

      // A fit that moves the clip again, now with music keys on it: the shaping runs again after the level.
      const refitted = await conn.request("music.fit", { cwd: project, clip, end: 12, hit: 19 });
      expect(refitted.after.in).toBe(7);
      expect(clipOf(clip).audio!.gain).toBe(gainFor(await partLufs(7, 20), target));
      expect(clipOf(clip).audio?.shape?.drops).toEqual([5]);
      await clearMusic();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "leaves the gain of a clip with keys of its own, naming it, and does nothing for a duck without a level",
    async () => {
      const clip = await addMusic();
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack], level: 12 });
      const gain = clipOf(clip).audio!.gain;
      await conn.request("clip.key", { cwd: project, clip, prop: "gain", time: 3, value: -2 });
      const fitted = await conn.request("music.fit", { cwd: project, clip, end: 10, hit: 19 });
      expect(clipOf(clip).audio!.gain).toBe(gain);
      expect(fitted.warnings.join(" ")).toContain("has gain keys of its own");
      await clearMusic();

      const plain = await addMusic();
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack] });
      const before = clipOf(plain).audio?.gain;
      const refit = await conn.request("music.fit", { cwd: project, clip: plain, end: 10, hit: 19 });
      expect(clipOf(plain).audio?.gain).toBe(before);
      expect(refit.warnings.join(" ")).not.toContain("set again from level");
      await clearMusic();
    },
    MEDIA_TIMEOUT,
  );
});
