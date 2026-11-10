import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `cleanup` through a real daemon. The recording is tone bursts and silence, the transcript is
// written by hand with the burst times, so every pause and retake has a known place:
//   hola 0-0.4 | quiet 0.6 | so the key 1.0-2.0 | quiet 1.0 | so the key idea 3.0-4.5 | quiet 1.5 | okay 6.0-6.5 | quiet to 8
const MEDIA_TIMEOUT = 180_000;

const WORDS: [string, number, number][] = [
  ["hola", 0, 0.4],
  ["so", 1.0, 1.3],
  ["the", 1.3, 1.6],
  ["key", 1.6, 2.0],
  ["so", 3.0, 3.3],
  ["the", 3.3, 3.6],
  ["key", 3.6, 4.0],
  ["idea", 4.0, 4.5],
  ["okay", 6.0, 6.5],
];
const BURSTS = WORDS.map(([, start, end], index) => [start, end - start, 300 + 40 * index] as const);

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "talk");
  await conn.request("project.init", { dir: root });
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

/** Import the recording, write its transcript, and put it on a video track (and an audio track with `both`). */
async function setup({ both = false, durationS = 8 }: { both?: boolean; durationS?: number } = {}) {
  const footage = join(tempDir(), "talk.mp4");
  await makeBurstClip(footage, { durationS, bursts: BURSTS });
  const { imported } = await conn.request("asset.import", { cwd: root, files: [footage] });
  const asset = imported[0]!.asset;
  mkdirSync(join(root, "transcripts"), { recursive: true });
  writeFileSync(
    join(root, "transcripts", "talk.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset,
      assetHash: `sha256:${createHash("sha256").update(readFileSync(join(root, asset))).digest("hex")}`,
      provider: "test",
      model: "test",
      language: "en",
      words: WORDS.map(([text, start, end], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end })),
    }),
  );
  const video = (await conn.request("track.add", { cwd: root, kind: "video", name: "Camera" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: root, track: video, asset, start: 0 });
  if (both) {
    const audio = (await conn.request("track.add", { cwd: root, kind: "audio", name: "Voice" })).changes.added[0]!;
    await conn.request("clip.add", { cwd: root, track: audio, asset, start: 0 });
  }
  return { asset, video };
}

const show = () => conn.request("timeline.show", { cwd: root, timeline: "main" });
const duration = async (): Promise<number> => (await show()).duration!;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("cleanup", () => {
  it("dry run lists pauses and retakes with their words and changes nothing", async () => {
    await setup();
    const before = await show();
    const result = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, applied: false, tx: null, revision: before.revision, words: WORDS.length });
    expect(result.candidates.map((c) => [c.id, c.kind])).toEqual([
      ["r1", "retake"],
      ["p1", "pause"],
    ]);
    const [retake, pause] = result.candidates;
    expect(retake!.words.map((w) => w.text)).toEqual(["so", "the", "key"]);
    expect(retake!.transcript).toBe("transcripts/talk.words.json");
    // Breath of 0.1 s left of the 0.4 to 1.0 pause before the first attempt and of the 2.0 to 3.0 one before the kept one.
    expect(retake!.start).toBeGreaterThan(0.45);
    expect(retake!.start).toBeLessThan(0.65);
    expect(retake!.end).toBeGreaterThan(2.85);
    expect(retake!.end).toBeLessThan(3.0);
    expect(pause!.words).toEqual([]);
    expect(pause!.start).toBeGreaterThan(4.55);
    expect(pause!.end).toBeLessThan(6.0);
    expect(pause!.confidence).toBeGreaterThan(0.8);
    expect(result.removed).toBeCloseTo(retake!.duration + pause!.duration, 2);
    expect(await show()).toEqual(before);
  }, MEDIA_TIMEOUT);

  it("looks for pauses by default; `pauses` sets the threshold and `false` leaves only retakes", async () => {
    await setup();
    const def = await conn.request("cleanup", { cwd: root, timeline: "main", dryRun: true });
    expect(def.candidates.map((c) => c.kind)).toEqual(["pause", "pause", "pause"]);
    const long = await conn.request("cleanup", { cwd: root, timeline: "main", pauses: 1.2, dryRun: true });
    expect(long.candidates.map((c) => c.start).length).toBe(1);
    const none = await conn.request("cleanup", { cwd: root, timeline: "main", pauses: false, retakes: true, dryRun: true });
    expect(none.candidates.map((c) => c.kind)).toEqual(["retake"]);
  }, MEDIA_TIMEOUT);

  it("applies in one labelled transaction, closes the gaps and leaves the breath", async () => {
    const { asset } = await setup();
    const before = await duration();
    const dry = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true, dryRun: true });
    const result = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true });
    expect(result).toMatchObject({ applied: true, dryRun: false, tx: expect.any(String) });
    expect(result.candidates).toEqual(dry.candidates);
    expect(await duration()).toBeCloseTo(before - dry.removed, 2);

    const history = await conn.request("history", { cwd: root, timeline: "main" });
    const tx = history.transactions.find((t) => t.tx === result.tx)!;
    expect(tx.label).toBe("Cleanup: 1 pause, 1 retake");
    expect(tx.operations.map((op) => op.op)).toEqual(["cut", "cut"]);

    // Struck in the transcript view = no clip plays the word any more; the kept take and its neighbours are played.
    const clips = (await show()).tracks.flatMap((track) => track.clips) as unknown as { asset: string; in: number; out: number }[];
    const plays = (second: number) => clips.some((clip) => clip.asset === asset && clip.in <= second && second < clip.out);
    for (const second of [1.15, 1.45, 1.8]) expect(plays(second)).toBe(false);
    for (const second of [0.2, 3.15, 3.45, 3.8, 4.25, 6.2]) expect(plays(second)).toBe(true);

    await conn.request("revert", { cwd: root, target: result.tx! });
    expect(await duration()).toBeCloseTo(before, 3);
  }, MEDIA_TIMEOUT);

  it("cuts video and audio tracks alike and counts the words once", async () => {
    await setup({ both: true });
    const result = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true });
    expect(result.words).toBe(WORDS.length);
    expect(result.candidates).toHaveLength(2);
    const view = await show();
    const ends = view.tracks.map((track) => Math.max(...track.clips.map((clip) => clip.end ?? 0)));
    expect(new Set(ends.map((end) => end.toFixed(2))).size).toBe(1);
  }, MEDIA_TIMEOUT);

  it("skips the candidates a person rejected", async () => {
    await setup();
    const dry = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true, dryRun: true });
    const before = await duration();
    const result = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true, skip: ["r1"] });
    expect(result.candidates.map((c) => c.id)).toEqual(["p1"]);
    expect(await duration()).toBeCloseTo(before - dry.candidates.find((c) => c.id === "p1")!.duration, 2);
    const error = await rejection(conn.request("cleanup", { cwd: root, timeline: "main", skip: ["p9"] }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toContain("p9");
  }, MEDIA_TIMEOUT);

  it("is a second run's no-op once the cuts are made", async () => {
    await setup();
    await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true });
    const again = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true });
    expect(again).toMatchObject({ applied: false, tx: null, candidates: [] });
  }, MEDIA_TIMEOUT);

  it("refuses options that cannot work and speech without a transcript", async () => {
    await setup();
    const big = await rejection(conn.request("cleanup", { cwd: root, timeline: "main", pauses: 0.4, breath: 0.3, dryRun: true }));
    expect(big.code).toBe(ErrorCode.InvalidOperation);
    expect(big.message).toContain("breath");
    const nothing = await rejection(conn.request("cleanup", { cwd: root, timeline: "main", pauses: false, dryRun: true }));
    expect(nothing.code).toBe(ErrorCode.InvalidOperation);
    rmSync(join(root, "transcripts", "talk.words.json"));
    const bare = await rejection(conn.request("cleanup", { cwd: root, timeline: "main", dryRun: true }));
    expect(bare.code).toBe(ErrorCode.InvalidOperation);
    expect(bare.message).toContain("no transcript");
    expect((bare.data as { hint: string }).hint).toContain("transcribe");
  }, MEDIA_TIMEOUT);

  it("leaves a transcript that no longer matches its file alone", async () => {
    await setup();
    const path = join(root, "transcripts", "talk.words.json");
    const transcript = JSON.parse(readFileSync(path, "utf8")) as { assetHash: string };
    transcript.assetHash = `sha256:${"0".repeat(64)}`;
    writeFileSync(path, JSON.stringify(transcript));
    const error = await rejection(conn.request("cleanup", { cwd: root, timeline: "main", dryRun: true }));
    expect(error.message).toContain("older than the file");
  }, MEDIA_TIMEOUT);

  it("is one proposal in review mode and changes the timeline only once accepted", async () => {
    await setup();
    const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
    try {
      await ui.request("review.set", { cwd: root, enabled: true });
      const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
      const length = await duration();
      const result = await conn.request("cleanup", { cwd: root, timeline: "main", retakes: true });
      expect(result.applied).toBe(true);
      expect(readFileSync(join(root, "timelines", "main.json"), "utf8")).toBe(before);
      const { proposal } = await conn.request("proposal.status", { cwd: root });
      expect(proposal).toMatchObject({ tx: result.tx, label: "Cleanup: 1 pause, 1 retake", operations: 2, state: "ready" });
      await ui.request("proposal.accept", { cwd: root, tx: result.tx! });
      expect(await duration()).toBeCloseTo(length - result.removed, 2);
    } finally {
      ui.close();
    }
  }, MEDIA_TIMEOUT);
});
