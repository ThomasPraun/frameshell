import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type ClipTrack, type MediaClip, type Timeline } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, LOUDNESS_DIR, measureLoudness, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeVoiceClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { kicks, music } from "./music-fixture.js";

// `music.candidates` through a real daemon. Five synthetic songs: `loud` and `quiet` (the same 26 s of kicks every half
// second and a crash at 20.345 s, 10 dB apart), `pad` (a hit that never falls away), `short` (8 s, shorter than the
// picture before the hit) and `silent`. The film is a 12 s voice with a marker `end-card` at 11 s.
const MEDIA_TIMEOUT = 240_000;
const RATE = 16_000;
const CRASH = 20.345;
const FPS = 30;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let ffmpeg: string;
let assets: Record<"loud" | "quiet" | "pad" | "short" | "silent", string>;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  ffmpeg = (await mediaTools()).ffmpeg;
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  mkdirSync(footage, { recursive: true });
  await makeVoiceClip(join(footage, "voice.mp4"), { own: [[2, 2, 440]], durationS: 12 });
  const song = (seconds: number, until: number, crashAt: number, level: number, decay = 2.5) =>
    wavOf(music(seconds, [...kicks(until).map((hit) => ({ ...hit, amplitude: hit.amplitude * level })), { at: crashAt, amplitude: 0.9 * level, decay }], { rate: RATE }), RATE);
  writeFileSync(join(footage, "loud.wav"), song(26, 19.5, CRASH, 1));
  writeFileSync(join(footage, "quiet.wav"), song(26, 19.5, CRASH, 0.32));
  writeFileSync(join(footage, "short.wav"), song(8, 6, 6.5, 1, 1.4));
  writeFileSync(join(footage, "pad.wav"), wavOf(music(24, [...kicks(15.5), { at: 16, amplitude: 0.25, decay: 9 }], { rate: RATE }), RATE));
  writeFileSync(join(footage, "silent.wav"), wavOf(new Float32Array(5 * RATE), RATE));
  const files = ["voice.mp4", "loud.wav", "quiet.wav", "pad.wav", "short.wav", "silent.wav"].map((name) => join(footage, name));
  const { imported } = await conn.request("asset.import", { cwd: project, files });
  const [, loud, quiet, pad, short, silent] = imported.map((entry) => entry.asset);
  assets = { loud: loud!, quiet: quiet!, pad: pad!, short: short!, silent: silent! };
  const voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  await conn.request("marker.add", { cwd: project, at: 11, label: "end-card" });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function timelineFile(): Promise<Timeline> {
  return JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
}
const round1 = (value: number) => Math.round(value * 10) / 10;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("music.candidates", () => {
  it(
    "plans a dry run: fitted to the cut, ranked, matched in loudness, silent file left out, nothing written",
    async () => {
      const before = (await timelineFile()).revision;
      const result = await conn.request("music.candidates", {
        cwd: project,
        assets: [assets.short, assets.pad, assets.silent, assets.quiet, assets.loud],
        end: "end-card",
        dryRun: true,
      });
      expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, revision: before, end: 11 });
      expect(result.skipped).toEqual([{ asset: assets.silent, reason: expect.stringContaining("silent") }]);

      // Both songs find the crash; the pad's hit is doubtful and the short file starts late: they rank after.
      const order = result.candidates.map((candidate) => candidate.asset);
      expect(new Set(order.slice(0, 2))).toEqual(new Set([assets.loud, assets.quiet]));
      expect(order.slice(2)).toEqual([assets.pad, assets.short]);
      expect(result.candidates.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4]);
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Music 1", "Music 2", "Music 3", "Music 4"]);
      expect(result.candidates.map((candidate) => candidate.muted)).toEqual([false, true, true, true]);
      expect(result.candidates.every((candidate) => candidate.track === null && candidate.clip === null)).toBe(true);

      const loud = result.candidates.find((candidate) => candidate.asset === assets.loud)!;
      expect(Math.abs(loud.hit!.at - CRASH)).toBeLessThan(0.02);
      expect(loud.hit!.confidence).toBeGreaterThan(0.8);
      expect(Math.abs(loud.landsAt! - 11)).toBeLessThanOrEqual(1 / FPS / 2 + 1e-6);
      expect(loud.introCut).toBeGreaterThan(9);
      const pad = result.candidates.find((candidate) => candidate.asset === assets.pad)!;
      expect(pad.hit!.confidence).toBeLessThan(0.5);
      expect(pad.warnings.join(" ")).toContain("doubtful");
      const short = result.candidates.find((candidate) => candidate.asset === assets.short)!;
      expect(short.silentBefore).toBeGreaterThan(3);
      expect(short.place.in).toBe(0);

      // One loudness: the quietest file is the target and is not touched, every other is turned down to it.
      const quiet = result.candidates.find((candidate) => candidate.asset === assets.quiet)!;
      expect(loud.loudness - quiet.loudness).toBeGreaterThan(8);
      expect(result.loudness.source).toBe("quietest");
      expect(result.loudness.target).toBe(Math.min(...result.candidates.map((candidate) => candidate.loudness)));
      for (const candidate of result.candidates) {
        expect(candidate.gain).toBe(round1(result.loudness.target - candidate.loudness));
        expect(candidate.gain).toBeLessThanOrEqual(0);
      }
      expect(loud.gain).toBeLessThan(-8);
      // The reading is the one ffmpeg gives the file itself.
      const own = await measureLoudness(ffmpeg, join(project, ...assets.loud.split("/")));
      expect(loud.loudness).toBe(own!.integrated);
      expect(await timelineFile()).toMatchObject({ revision: before });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "adds one audio track per candidate in one transaction, all muted but the first, and one revert undoes it",
    async () => {
      const original = await timelineFile();
      const result = await conn.request("music.candidates", { cwd: project, assets: [assets.loud, assets.quiet, assets.short], end: "end-card" });
      expect(result).toMatchObject({ dryRun: false, applied: true });
      expect(result.tx).toMatch(/^tx_/);
      expect(result.candidates.every((candidate) => candidate.track !== null && candidate.clip !== null)).toBe(true);

      const written = await timelineFile();
      expect(written.tracks).toHaveLength(original.tracks.length + 3);
      for (const candidate of result.candidates) {
        const track = written.tracks.find((entry) => entry.id === candidate.track) as ClipTrack;
        expect(track).toMatchObject({ kind: "audio", name: candidate.name });
        expect(track.muted === true).toBe(candidate.muted);
        const clip = track.clips[0] as MediaClip;
        expect(clip).toMatchObject({ id: candidate.clip, asset: candidate.asset, start: candidate.place.start, in: candidate.place.in });
        expect(clip.audio?.gain ?? 0).toBe(candidate.gain);
        if (candidate.hit) {
          const lands = clip.start + (candidate.hit.at - clip.in) / (clip.speed ?? 1);
          expect(Math.abs(lands - 11)).toBeLessThanOrEqual(1 / FPS / 2 + 1e-6);
        }
      }

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.label).toBe(`Music candidates: 3 tracks at ${result.loudness.target} LUFS`);
      expect(tx.operations.filter((op) => op.op === "track.add")).toHaveLength(3);
      expect(tx.operations.filter((op) => op.op === "track.set")).toHaveLength(2);
      expect(tx.operations.filter((op) => op.op === "clip.add")).toHaveLength(3);

      await conn.request("revert", { cwd: project, target: result.tx! });
      expect((await timelineFile()).tracks.map((track) => track.id)).toEqual(original.tracks.map((track) => track.id));
    },
    MEDIA_TIMEOUT,
  );

  it(
    "places the files whole from `from`, in the order given, at a loudness asked for",
    async () => {
      const result = await conn.request("music.candidates", { cwd: project, assets: [assets.quiet, assets.loud], from: 2, loudness: -30, dryRun: true });
      expect(result.end).toBeNull();
      expect(result.candidates.map((candidate) => candidate.asset)).toEqual([assets.quiet, assets.loud]);
      expect(result.candidates.map((candidate) => candidate.place)).toEqual([
        { start: 2, in: 0, speed: 1, end: 28 },
        { start: 2, in: 0, speed: 1, end: 28 },
      ]);
      expect(result.candidates.every((candidate) => candidate.hit === null && candidate.landsAt === null)).toBe(true);
      expect(result.loudness).toEqual({ target: -30, source: "given" });
      expect(result.ranking).toContain("order of `assets`");
      // Louder than the target: turned down. A target above the file raises it, and the peak is watched.
      const loud = await conn.request("music.candidates", { cwd: project, assets: [assets.quiet, assets.loud], loudness: -3, dryRun: true });
      expect(loud.candidates.every((candidate) => candidate.gain > 0)).toBe(true);
      expect(loud.candidates.some((candidate) => candidate.warnings.join(" ").includes("dBTP"))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "measures each file once and keeps the reading under .frameshell/loudness, which gc sweeps by content",
    async () => {
      const files = readdirSync(join(project, ...LOUDNESS_DIR.split("/")));
      const readings = files.filter((name) => name.endsWith(".json"));
      // loud, quiet, pad, short and silent were each read once, whatever the calls above asked.
      expect(readings).toHaveLength(5);
      const planted = join(project, ...LOUDNESS_DIR.split("/"), "aaaaaaaaaaaaaaaaaaaa-l1.json");
      writeFileSync(planted, "{}");
      const swept = await conn.request("gc", { cwd: project, dryRun: false });
      expect(swept.removed.filter((entry) => entry.kind === "loudness").map((entry) => entry.path)).toEqual([`${LOUDNESS_DIR}/aaaaaaaaaaaaaaaaaaaa-l1.json`]);
      expect(readdirSync(join(project, ...LOUDNESS_DIR.split("/"))).filter((name) => name.endsWith(".json"))).toHaveLength(5);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses what cannot be placed before writing anything",
    async () => {
      const before = (await timelineFile()).revision;
      const duplicate = await rejection(conn.request("music.candidates", { cwd: project, assets: [assets.loud, assets.loud] }));
      expect(duplicate.code).toBe(ErrorCode.InvalidOperation);
      expect(duplicate.data).toMatchObject({ reason: "duplicate" });
      const early = await rejection(conn.request("music.candidates", { cwd: project, assets: [assets.loud, assets.quiet], end: 1, from: 5 }));
      expect(early.data).toMatchObject({ reason: "end before from" });
      const missing = await rejection(conn.request("music.candidates", { cwd: project, assets: [assets.loud, "assets/nope.wav"] }));
      expect(missing.code).toBe(ErrorCode.AssetNotFound);
      const allSilent = await conn.request("music.candidates", { cwd: project, assets: [assets.silent, assets.loud], dryRun: true });
      expect(allSilent.skipped).toHaveLength(1);
      expect(allSilent.candidates).toHaveLength(1);
      expect(allSilent.warnings.join(" ")).toContain("Only one file");
      expect((await rejection(conn.request("music.candidates", { cwd: project, assets: [assets.loud] }))).code).toBe(ErrorCode.InvalidParams);
      expect((await timelineFile()).revision).toBe(before);
    },
    MEDIA_TIMEOUT,
  );
});
