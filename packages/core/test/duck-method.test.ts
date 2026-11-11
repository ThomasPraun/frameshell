import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline, gainAt } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstAudio, makeVoiceClip } from "./media-fixtures.js";
import { mediaTools, runBuffer, testBinaryManager } from "./media-tools.js";

// `track.duck` through a real daemon: a voice with two bursts (440 Hz, 2-4 s and 7-9 s) over a steady 1 kHz bed, then
// the export of that timeline, to hear the bed dip. The bed is as loud as the voice so the mix stays within loudnorm's
// 20 LU range: past it the export normalizes dynamically and levels drift over time.
const MEDIA_TIMEOUT = 240_000;
const BURSTS = [
  [2, 2, 440],
  [7, 2, 440],
] as const;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let voiceTrack: string;
let bedTrack: string;
let bedClip: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeVoiceClip(join(footage, "voice.mp4"), { own: BURSTS, durationS: 12 });
  await makeBurstAudio(join(footage, "bed.wav"), { durationS: 12, bursts: [[0, 12, 1000]] });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "voice.mp4"), join(footage, "bed.wav")] });
  voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  bedTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  bedClip = (await conn.request("clip.add", { cwd: project, track: bedTrack, asset: imported[1]!.asset, start: 0, in: 0, out: 12 })).changes.added[0]!;
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

async function finished(id: string): Promise<JobInfo> {
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; ) {
    const job = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === id);
    if (job && job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

/** Amplitude of the `frequency` component in 20 ms of `samples` centered on second `at` (Hann-windowed DFT bin). */
function amplitude(samples: Float32Array, at: number, frequency: number): number {
  const length = 960;
  const first = Math.round(at * 48_000) - length / 2;
  let re = 0;
  let im = 0;
  let weights = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const phase = (2 * Math.PI * frequency * (first + i)) / 48_000;
    re += samples[first + i]! * w * Math.cos(phase);
    im += samples[first + i]! * w * Math.sin(phase);
    weights += w;
  }
  return (2 * Math.hypot(re, im)) / weights;
}

describe("track.duck", () => {
  it(
    "dips the bed by the depth while the voice speaks and writes marked gain keys, in one operation",
    async () => {
      const result = await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack] });
      expect(result).toMatchObject({ track: bedTrack, under: [voiceTrack], stretches: 2, changes: { updated: [bedClip] }, warnings: [] });
      expect(result.speechSeconds).toBeGreaterThan(3.9);
      expect(result.speechSeconds).toBeLessThan(4.3);

      const clip = await bed();
      expect(clip.keys?.gain?.every((key) => key.auto === "duck")).toBe(true);
      // Full level before the voice, the whole depth inside it, and back after the release.
      expect(gainAt(clip, 0)).toBe(0);
      expect(gainAt(clip, 1.5)).toBe(0);
      expect(gainAt(clip, 3)).toBe(-7);
      expect(gainAt(clip, 5.5)).toBe(0);
      expect(gainAt(clip, 8)).toBe(-7);
      expect(gainAt(clip, 11)).toBe(0);
      // It is on its way down as the voice starts and half way back during the release.
      expect(gainAt(clip, 2.1)).toBe(-7);
      expect(gainAt(clip, 4.3)).toBeLessThan(0);
      expect(gainAt(clip, 4.3)).toBeGreaterThan(-7);

      const history = await conn.request("history", { cwd: project });
      expect(history.transactions.flatMap((tx) => tx.operations).filter((op) => op.op === "track.duck")).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps the same keys when run again, and a key set by hand",
    async () => {
      const before = (await bed()).keys;
      await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack] });
      expect((await bed()).keys).toEqual(before);

      await conn.request("clip.key", { cwd: project, clip: bedClip, prop: "gain", time: 11.5, value: -1 });
      await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack], depth: 10 });
      const clip = await bed();
      expect(clip.keys?.gain?.find((key) => key.at === 11.5)).toEqual({ at: 11.5, value: -1 });
      // The hand key sets the level the dip is taken from (a lane holds its first key back to the clip start): -1 - 10.
      expect(gainAt(clip, 3)).toBe(-11);
      await conn.request("clip.key", { cwd: project, clip: bedClip, prop: "gain", time: 11.5, remove: true });
      await conn.request("track.duck", { cwd: project, track: bedTrack, under: [voiceTrack] });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "plays the dip in the export",
    async () => {
      const { job, output } = await conn.request("render", { cwd: project });
      expect(await finished(job.id)).toMatchObject({ state: "done" });
      const { ffmpeg } = await mediaTools();
      const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"]);
      const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.floor(raw.length / 4) * 4));
      const bedAt = (t: number) => amplitude(samples, t, 1000);
      const full = bedAt(1);
      expect(bedAt(10)).toBeGreaterThan(full * 0.95);
      for (const t of [3, 8]) {
        const ratio = bedAt(t) / full;
        // 7 dB down is 0.447 of the amplitude.
        expect(Math.abs(ratio - 10 ** (-7 / 20)), `bed at ${t}`).toBeLessThan(0.04);
      }
      // The voice is still there, at its own level.
      expect(amplitude(samples, 3, 440)).toBeGreaterThan(full * 0.5);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a video track as the bed, and the bed as its own voice", async () => {
    await expect(conn.request("track.duck", { cwd: project, track: voiceTrack, under: [bedTrack] })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(conn.request("track.duck", { cwd: project, track: bedTrack, under: [bedTrack] })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(conn.request("track.duck", { cwd: project, track: bedTrack, under: ["t_nope"] })).rejects.toMatchObject({ code: ErrorCode.TrackNotFound });
  });

  it(
    "removes the keys and says so when the voice track holds no speech",
    async () => {
      const quiet = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
      const result = await conn.request("track.duck", { cwd: project, track: bedTrack, under: [quiet] });
      expect(result.stretches).toBe(0);
      expect(result.warnings.join(" ")).toMatch(/no clip of .* lies under speech/);
      expect((await bed()).keys).toBeUndefined();
    },
    MEDIA_TIMEOUT,
  );
});
