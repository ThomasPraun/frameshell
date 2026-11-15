import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import type { BeatsFile } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `music.grid` on program tracks and upper tracks (ADR 0037, after slice 5), through a real daemon. Two synthetic cameras
// that share tone bursts make a multicam group; its one shot is split at 3.3 s (a beat is at 3.5 s). A clip alone on an upper
// video track starts at 5.3 s (beat at 5.5 s). The music is a silent WAV with a hand-written `exact` beats file: a beat every
// 0.5 s from 0.5 s.
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let program = "";
let upper = "";
let overlay = "";
let firstShot = "";
let secondShot = "";

const request = <K extends Parameters<DaemonConnection["request"]>[0]>(method: K, params: Record<string, unknown> = {}) =>
  conn.request(method, { cwd: project, ...params } as never) as Promise<never>;
const grid = (params: Record<string, unknown> = {}) => request("music.grid", params) as Promise<ReturnType<(typeof methods)["music.grid"]["result"]["parse"]>>;
const clips = () =>
  Object.fromEntries(
    (JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as { tracks: { clips?: { id: string; start: number; in: number; out: number; type: string }[] }[] }).tracks
      .flatMap((track) => track.clips ?? [])
      .map((clip) => [clip.id, clip]),
  );

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeBurstClip(join(footage, "ana.mp4"), { shiftS: 0, durationS: 10 });
  await makeBurstClip(join(footage, "ben.mp4"), { shiftS: 0, durationS: 10 });
  await makeBurstClip(join(footage, "title.mp4"), { durationS: 4, bursts: [[1, 0.06, 330]] });
  writeFileSync(join(footage, "music.wav"), wavOf(new Float32Array(48_000 * 12), 48_000));
  const { imported } = await conn.request("asset.import", {
    cwd: project,
    files: ["ana.mp4", "ben.mp4", "title.mp4", "music.wav"].map((name) => join(footage, name)),
  });
  const [ana, ben, title, musicAsset] = imported.map((entry) => entry.asset);
  const beats: BeatsFile = {
    schemaVersion: 1,
    asset: musicAsset!,
    assetHash: `sha256:${"0".repeat(64)}`,
    detector: "exact",
    bpm: 120,
    meter: 4,
    downbeat: 0,
    confidence: 1,
    beats: Array.from({ length: 22 }, (_, index) => 0.5 + index * 0.5),
    edits: {},
  };
  mkdirSync(join(project, "beats"), { recursive: true });
  writeFileSync(join(project, "beats", "music.beats.json"), JSON.stringify(beats));

  const created = await conn.request("multicam.create", { cwd: project, assets: [ana!, ben!], names: ["Ana", "Ben"] });
  program = created.track;
  firstShot = created.clip;
  const split = (await request("clip.split", { clip: firstShot, at: 3.3 })) as { changes: { added: string[] } };
  secondShot = split.changes.added.find((id) => id.startsWith("c_"))!;
  upper = ((await request("track.add", { kind: "video" })) as { changes: { added: string[] } }).changes.added[0]!;
  overlay = ((await request("clip.add", { track: upper, asset: title, start: 5.3, in: 0, out: 2 })) as { changes: { added: string[] } }).changes.added[0]!;
  const audio = ((await request("track.add", { kind: "audio" })) as { changes: { added: string[] } }).changes.added[0]!;
  const music = ((await request("clip.add", { track: audio, asset: musicAsset, start: 0, out: 11 })) as { changes: { added: string[] } }).changes.added[0]!;
  await request("tempo.set", { clip: music });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("music.grid on program tracks and upper tracks", () => {
  it("lists a program cut and an upper-track entry beside the video cuts", async () => {
    const result = await grid({ dryRun: true });
    expect(methods["music.grid"].result.parse(result)).toEqual(result);
    expect(result).toMatchObject({ trim: "tail", tracks: "all", moved: 2 });
    expect(result.cuts.map(({ id, kind, at, track, out, in: into, ref, status }) => ({ id, kind, at, track, out, in: into, ref, status }))).toEqual([
      { id: "g1", kind: "program", at: 3.3, track: program, out: firstShot, in: secondShot, ref: "beat:7", status: "move" },
      { id: "g2", kind: "entry", at: 5.3, track: upper, out: null, in: overlay, ref: "beat:11", status: "move" },
    ]);
  }, MEDIA_TIMEOUT);

  it("moves the shot change as a roll edit and the entry whole, in one transaction", async () => {
    const result = await grid();
    expect(result).toMatchObject({ applied: true, moved: 2, durationChange: 0 });
    const after = clips();
    // The shots meet on 3.5 s; the group clock did not move: the second shot lost its first 0.2 s, the first gained them.
    expect(after[firstShot]).toMatchObject({ start: 0, in: 0, out: 3.5 });
    expect(after[secondShot]).toMatchObject({ start: 3.5, in: 3.5 });
    // The title keeps its length and starts on the beat.
    expect(after[overlay]).toMatchObject({ start: 5.5, in: 0, out: 2 });
    const history = (await request("history", { timeline: "main" })) as { transactions: { tx: string; label: string | null }[] };
    expect(history.transactions.at(-1)).toMatchObject({ tx: result.tx, label: "Music grid: 2 cuts onto beats" });
    await request("revert", { target: result.tx });
    expect(clips()[overlay]).toMatchObject({ start: 5.3 });
    expect(clips()[secondShot]).toMatchObject({ start: 3.3, in: 3.3 });
  }, MEDIA_TIMEOUT);

  it("skips a move by id, entries included", async () => {
    const result = await grid({ skip: ["g2"] });
    expect(result.cuts.map((cut) => cut.status)).toEqual(["move", "skipped"]);
    expect(clips()[overlay]).toMatchObject({ start: 5.3 });
    await request("revert", { target: result.tx });
  }, MEDIA_TIMEOUT);

  it("reads video cuts only with tracks: video", async () => {
    const before = readFileSync(join(project, "timelines", "main.json"), "utf8");
    const result = await grid({ tracks: "video" });
    expect(result).toMatchObject({ tracks: "video", applied: false, moved: 0, cuts: [] });
    expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(before);
  }, MEDIA_TIMEOUT);
});
