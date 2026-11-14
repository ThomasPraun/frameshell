import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import type { BeatsFile } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `music.grid` through a real daemon (ADR 0037 slice 5). The shots are one synthetic recording with sound, its transcript
// written by hand with one word at 2.0–2.06 s of the file. The music is a silent WAV whose beat grid is a hand-written
// `exact` beats file: a beat every 0.5 s from 0.5 s. Shots meet at 2.1 s (off the grid; moving it to 2.0 s would cut the
// word) and 4.4 s (moves to 4.5 s).
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let video = "";
const shots: string[] = [];

const request = <K extends Parameters<DaemonConnection["request"]>[0]>(method: K, params: Record<string, unknown> = {}) =>
  conn.request(method, { cwd: project, ...params } as never) as Promise<never>;
const grid = (params: Record<string, unknown> = {}) => request("music.grid", params) as Promise<ReturnType<(typeof methods)["music.grid"]["result"]["parse"]>>;
const timelineFile = () => JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as { tracks: { id: string; clips: { id: string; start: number; in: number; out: number }[] }[] };
const placed = (id: string) => {
  const clip = timelineFile().tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === id)!;
  return { start: clip.start, end: Math.round((clip.start + clip.out - clip.in) * 1000) / 1000 };
};

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeBurstClip(join(footage, "shots.mp4"), { durationS: 10, bursts: [[2, 0.06, 440]] });
  writeFileSync(join(footage, "music.wav"), wavOf(new Float32Array(48_000 * 12), 48_000));
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "shots.mp4"), join(footage, "music.wav")] });
  const [shotsAsset, musicAsset] = imported.map((entry) => entry.asset);
  mkdirSync(join(project, "transcripts"), { recursive: true });
  writeFileSync(
    join(project, "transcripts", "shots.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset: shotsAsset,
      assetHash: `sha256:${createHash("sha256").update(readFileSync(join(project, shotsAsset!))).digest("hex")}`,
      provider: "test",
      model: "test",
      language: "en",
      words: [{ id: "w_000001", text: "okay", start: 2, end: 2.06 }],
    }),
  );
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

  video = (await request<"track.add">("track.add", { kind: "video" }) as { changes: { added: string[] } }).changes.added[0]!;
  for (const [start, from, to] of [[0, 0, 2.1], [2.1, 3, 5.3], [4.4, 6, 8]] as const) {
    const added = (await request("clip.add", { track: video, asset: shotsAsset, start, in: from, out: to })) as { changes: { added: string[] } };
    shots.push(added.changes.added[0]!);
  }
  const audio = ((await request("track.add", { kind: "audio" })) as { changes: { added: string[] } }).changes.added[0]!;
  const music = ((await request("clip.add", { track: audio, asset: musicAsset, start: 0, out: 11 })) as { changes: { added: string[] } }).changes.added[0]!;
  await request("tempo.set", { clip: music });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("music.grid", () => {
  it("dry run lists every cut with its beat and changes nothing", async () => {
    const before = readFileSync(join(project, "timelines", "main.json"), "utf8");
    const result = await grid({ dryRun: true });
    expect(methods["music.grid"].result.parse(result)).toEqual(result);
    expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, moved: 1, to: "beat", maxShift: 0.25, grid: { source: "beats", bpm: 120, confidence: 1 } });
    expect(result.cuts.map(({ id, at, ref, status }) => ({ id, at, ref, status }))).toEqual([
      { id: "g1", at: 2.1, ref: "beat:4", status: "blocked" },
      { id: "g2", at: 4.4, ref: "beat:9", status: "move" },
    ]);
    expect(result.cuts[0]!.reason).toMatch(/would cut "okay" from the end of/);
    expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(before);
  }, MEDIA_TIMEOUT);

  it("moves the cuts in one transaction that revert undoes", async () => {
    const result = await grid();
    expect(result).toMatchObject({ applied: true, moved: 1, durationChange: 0.1 });
    expect([placed(shots[0]!), placed(shots[1]!), placed(shots[2]!)]).toEqual([
      { start: 0, end: 2.1 },
      { start: 2.1, end: 4.5 },
      { start: 4.5, end: 6.5 },
    ]);
    const history = (await request("history", { timeline: "main" })) as { transactions: { tx: string; label: string | null }[] };
    expect(history.transactions.at(-1)).toMatchObject({ tx: result.tx, label: "Music grid: 1 cut onto beats" });
    await request("revert", { target: result.tx });
    expect(placed(shots[2]!)).toEqual({ start: 4.4, end: 6.4 });
  }, MEDIA_TIMEOUT);

  it("refuses a skip id that is no move", async () => {
    await expect(grid({ skip: ["g7"] })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "skip" } });
  });
});
