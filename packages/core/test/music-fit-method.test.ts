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

// `music.fit` through a real daemon. The song is 26 s of kicks every half second with a crash at 20.345 s that rings out;
// the pad is the same bed under a hit that never falls away (a track that goes on). The film is a 12 s voice with
// speech at 2-4 s and 7-9 s, a marker `end-card` at 11 s, and the song on its own audio track.
const MEDIA_TIMEOUT = 240_000;
const RATE = 16_000;
const CRASH = 20.345;
const FPS = 30;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let voiceTrack: string;
let musicTrack: string;
let clip: string;
let padClip: string;

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
  writeFileSync(join(footage, "pad.wav"), wavOf(music(24, [...kicks(15.5), { at: 16, amplitude: 0.25, decay: 9 }], { rate: RATE }), RATE));
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "voice.mp4"), join(footage, "song.wav"), join(footage, "pad.wav")] });
  voiceTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  musicTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: voiceTrack, asset: imported[0]!.asset, start: 0, in: 0, out: 12 });
  clip = (await conn.request("clip.add", { cwd: project, track: musicTrack, asset: imported[1]!.asset, start: 0, in: 0, out: 26 })).changes.added[0]!;
  const padTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  padClip = (await conn.request("clip.add", { cwd: project, track: padTrack, asset: imported[2]!.asset, start: 0, in: 0, out: 24 })).changes.added[0]!;
  // Muted, so duck does not take the pad for a voice.
  await conn.request("track.set", { cwd: project, track: padTrack, muted: true });
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

/** Timeline second where source second `at` of the clip plays. */
const placed = (c: MediaClip, at: number) => c.start + (at - c.in) / (c.speed ?? 1);
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

describe("music.fit", () => {
  it(
    "plans a dry run from a marker, finding the hit, and changes nothing",
    async () => {
      const before = await revision();
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card", dryRun: true });
      expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, revision: before, mode: "slide", clip, track: musicTrack, end: 11, speedChangePercent: null });
      expect(result.hit.source).toBe("detected");
      expect(Math.abs(result.hit.at - CRASH)).toBeLessThan(0.02);
      expect(result.hit.confidence).toBeGreaterThan(0.8);
      expect(result.hit.candidates.at(-1)!.at).toBe(result.hit.at);
      // 20.3 s of track before the hit, 11 s of picture: the first 9.3 s of the song go.
      expect(result.before).toMatchObject({ start: 0, in: 0, speed: 1 });
      expect(result.after.start).toBe(0);
      expect(result.after.in).toBeGreaterThan(9.2);
      expect(result.after.in).toBeLessThan(9.4);
      expect(result.introCut).toBe(result.after.in);
      expect(Math.abs(result.offsetMs)).toBeLessThanOrEqual(1000 / FPS / 2 + 0.1);
      // The intro goes and the music stays at 0 s: no `place` step, though the clip is moved back after the head trim.
      expect(result.steps.map((step) => step.id)).toEqual(["intro"]);
      expect(result.tail).toBeGreaterThan(5);
      expect(await revision()).toBe(before);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "slides the clip in one transaction so the hit lands on the cut, and one revert undoes it",
    async () => {
      const original = await clipOf(clip);
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
      expect(result).toMatchObject({ applied: true, dryRun: false });
      expect(result.tx).toMatch(/^tx_/);
      const fitted = await clipOf(clip);
      expect(fitted.start).toBe(0);
      expect(fitted.in).toBe(result.after.in);
      expect(Math.abs(placed(fitted, result.hit.at) - 11)).toBeLessThanOrEqual(1 / FPS / 2 + 1e-6);
      expect(result.landsAt).toBeCloseTo(placed(fitted, result.hit.at), 3);

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.label).toMatch(/^Music fit: /);
      expect(tx.operations.map((op) => op.op)).toEqual(["clip.trim", "clip.move"]);

      await conn.request("revert", { cwd: project, target: result.tx! });
      expect(await clipOf(clip)).toEqual(original);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "starts the music late, never looped, when the track is shorter than the picture before the hit",
    async () => {
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 40, hit: CRASH });
      expect(result.hit).toMatchObject({ source: "given", confidence: 1, candidates: [] });
      expect(result.silentBefore).toBeGreaterThan(19);
      expect(result.introCut).toBe(0);
      expect(result.warnings.join(" ")).toContain("never looped or spliced");
      expect((await clipOf(clip)).start).toBe(result.after.start);
      expect(Math.abs(placed(await clipOf(clip), CRASH) - 40)).toBeLessThanOrEqual(1 / FPS / 2 + 1e-6);
      await conn.request("revert", { cwd: project, target: result.tx! });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "varispeeds with `exact`, keeping the start, and refuses past 1.7 % without writing",
    async () => {
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 20.6, exact: true });
      expect(result.mode).toBe("exact");
      const fitted = await clipOf(clip);
      expect(fitted.start).toBe(0);
      expect(fitted.in).toBe(0);
      expect(fitted.speed).toBeCloseTo(result.hit.at / 20.6, 5);
      expect(Math.abs(result.speedChangePercent!)).toBeLessThan(1.7);
      expect(Math.abs(result.offsetMs)).toBeLessThan(0.5);
      expect(placed(fitted, result.hit.at)).toBeCloseTo(20.6, 3);
      expect((await conn.request("history", { cwd: project })).transactions.find((entry) => entry.tx === result.tx)!.operations.map((op) => op.op)).toEqual(["clip.set"]);
      await conn.request("revert", { cwd: project, target: result.tx! });

      const before = await revision();
      const refused = await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 22, exact: true }));
      expect(refused.code).toBe(ErrorCode.InvalidOperation);
      expect(refused.message).toMatch(/slower by \d+(\.\d+)? %/);
      expect(refused.data).toMatchObject({ reason: "varispeed limit" });
      expect(await revision()).toBe(before);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "never varispeeds on a doubtful hit, but slides with a warning",
    async () => {
      const refused = await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip: padClip, end: 20, exact: true }));
      expect(refused.data).toMatchObject({ reason: "low confidence" });
      const slid = await conn.request("music.fit", { cwd: project, timeline: "main", clip: padClip, end: 20, dryRun: true });
      expect(slid.hit.confidence).toBeLessThan(0.5);
      expect(slid.warnings.join(" ")).toContain("doubtful");
      const given = await conn.request("music.fit", { cwd: project, timeline: "main", clip: padClip, end: 16.2, exact: true, hit: 16, dryRun: true });
      expect(given.mode).toBe("exact");
      expect(given.hit).toMatchObject({ source: "given", confidence: 1 });
    },
    MEDIA_TIMEOUT,
  );

  it("refuses what is not music, a hit outside the clip, an unknown marker and an unknown clip", async () => {
    const video = (await conn.request("timeline.show", { cwd: project, timeline: "main" })).tracks.find((track) => track.id === voiceTrack)!.clips![0]!.id;
    expect((await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip: video, end: 11 }))).data).toMatchObject({ reason: "not music" });
    expect((await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 11, hit: 30 }))).data).toMatchObject({ reason: "hit outside the clip" });
    const marker = await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "nowhere" }));
    expect(marker.code).toBe(ErrorCode.InvalidOperation);
    expect(marker.message).toContain("music.fit: end:");
    expect(marker.message).toContain("end-card");
    expect((await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip: "c_nope", end: 11 }))).code).toBe(ErrorCode.ClipNotFound);
    expect((await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 11, skip: ["place"] }))).data).toMatchObject({ reason: "skip" });
  });

  it(
    "refuses a place that overlaps another clip of the track before writing anything",
    async () => {
      const other = (await conn.request("clip.add", { cwd: project, track: musicTrack, asset: (await clipOf(clip)).asset, start: 27, in: 0, out: 5 })).changes.added[0]!;
      const before = await revision();
      const refused = await rejection(conn.request("music.fit", { cwd: project, timeline: "main", clip, end: 40, hit: CRASH }));
      expect(refused.data).toMatchObject({ reason: "overlap" });
      expect(await revision()).toBe(before);
      await conn.request("clip.remove", { cwd: project, clip: other });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "runs duck again over the voice in the same transaction when the clip carries duck keys, or leaves them with skip",
    async () => {
      await conn.request("track.duck", { cwd: project, track: musicTrack, under: [voiceTrack] });
      const ducked = await clipOf(clip);
      expect(ducked.keys?.gain?.some((key) => key.auto === "duck")).toBe(true);

      const kept = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card", skip: ["duck"] });
      expect(kept.duck).toEqual({ under: [voiceTrack], rerun: false });
      expect(kept.warnings.join(" ")).toContain("skipped");
      expect((await conn.request("history", { cwd: project })).transactions.find((entry) => entry.tx === kept.tx)!.operations.map((op) => op.op)).toEqual(["clip.trim", "clip.move"]);
      await conn.request("revert", { cwd: project, target: kept.tx! });

      const dry = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card", dryRun: true });
      expect(dry.steps.map((step) => step.id)).toEqual(["intro", "duck"]);
      const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
      expect(result.duck).toEqual({ under: [voiceTrack], rerun: true });
      const tx = (await conn.request("history", { cwd: project })).transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.operations.map((op) => op.op)).toEqual(["clip.trim", "clip.move", "track.duck"]);
      // The dips sit under the speech again (2-4 s and 7-9 s of the film), not where the song's own clock put them.
      const fitted = await clipOf(clip);
      expect(gainAt(fitted, 3)).toBe(-7);
      expect(gainAt(fitted, 8)).toBe(-7);
      expect(gainAt(fitted, 5.5)).toBe(0);
      await conn.request("revert", { cwd: project, target: result.tx! });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "is one proposal in review mode, with its duck, and changes the timeline only once accepted",
    async () => {
      const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
      try {
        await ui.request("review.set", { cwd: project, enabled: true });
        const before = await readFile(join(project, "timelines", "main.json"), "utf8");
        const result = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
        expect(result.applied).toBe(true);
        expect(await readFile(join(project, "timelines", "main.json"), "utf8")).toBe(before);
        const { proposal } = await conn.request("proposal.status", { cwd: project });
        expect(proposal).toMatchObject({ tx: result.tx, state: "ready" });
        expect(proposal!.label).toMatch(/^Music fit: /);
        await ui.request("proposal.accept", { cwd: project, tx: result.tx! });
        expect((await clipOf(clip)).in).toBe(result.after.in);
        await ui.request("review.set", { cwd: project, enabled: false });
        await conn.request("revert", { cwd: project, target: result.tx! });
      } finally {
        ui.close();
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "says there is nothing to change when the hit already lands",
    async () => {
      const first = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
      const again = await conn.request("music.fit", { cwd: project, timeline: "main", clip, end: "end-card" });
      expect(again).toMatchObject({ applied: false, tx: null });
      expect(again.warnings.join(" ")).toContain("nothing to change");
      await conn.request("revert", { cwd: project, target: first.tx! });
    },
    MEDIA_TIMEOUT,
  );
});
