import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, standInSpeechProvider, startDaemon } from "../src/index.js";
import { FrameGrid } from "../src/timeline/grid.js";
import { clipEnd } from "../src/timeline/timing.js";
import { phraseEnd } from "../src/voiceover/place.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `voiceover.place` (ADR 0034 decision 19) through a real in-process daemon with the stand-in voice,
// whose words are 0.3 s tones 0.1 s apart: every word of a line is one phrase.

const FPS = 30;
const HALF_FRAME = 0.5 / FPS + 1e-6;

const script = (lines: string[]) => ["---", "title: Launch", "voiceover: true", "language: en", "provider: stand-in", "---", ...lines].join("\n");
// hook-1 has three phrases, hook-2 two, fix-1 two.
const LINES = ["## Hook", "One two three.", "Four five.", "## Fix", "Six seven."];

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    speechProviders: [standInSpeechProvider()],
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch-vo.md"), script(LINES));
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const generate = (params: Record<string, unknown> = {}) => conn.request("voiceover.generate", { cwd: root, script: "scripts/launch-vo.md", verify: false, ...params });
const place = (params: Record<string, unknown> = {}) => conn.request("voiceover.place", { cwd: root, timeline: "main", script: "scripts/launch-vo.md", ...params } as never);
const timeline = (): Timeline => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")) as Timeline;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};
const frames = (seconds: number) => Math.round(seconds * FPS);

describe("voiceover.place", () => {
  it("puts one clip per phrase on a new Voiceover track, phrases at the spacing of the take, lines a gap apart, in one transaction", async () => {
    const said = await generate();
    const result = await place();

    expect(result.track).toMatchObject({ name: "Voiceover", created: true });
    expect(result.dryRun).toBe(false);
    expect(result.placed.map((clip) => `${clip.line}.${clip.phrase}`)).toEqual(["hook-1.1", "hook-1.2", "hook-1.3", "hook-2.1", "hook-2.2", "fix-1.1", "fix-1.2"]);
    expect(result.placed.map((clip) => clip.anchor)).toEqual(["start", "spacing", "spacing", "follows", "spacing", "follows", "spacing"]);
    expect(result.lines.map((line) => [line.id, line.anchor])).toEqual([["hook-1", "start"], ["hook-2", "follows"], ["fix-1", "follows"]]);

    // Phrase k of hook-1 sits where the take has it, from the first one.
    const hook = said.lines[0]!.phrases;
    const first = result.placed[0]!;
    expect(first).toMatchObject({ start: 0, file: "assets/voiceover/launch-vo/hook-1.wav" });
    for (const [index, clip] of result.placed.slice(0, 3).entries()) {
      expect(clip.in).toBeCloseTo(frames(hook[index]!.from) / FPS, 2);
      expect(frames(clip.start) - frames(first.start)).toBe(frames(hook[index]!.from) - frames(hook[0]!.from));
      expect(frames(clip.end) - frames(clip.start)).toBe(frames(clip.out) - frames(clip.in));
    }
    // The second line starts 0.4 s (12 frames) after the first one's last phrase ends.
    expect(frames(result.placed[3]!.start)).toBe(frames(result.placed[2]!.end) + 12);

    const written = timeline();
    const track = written.tracks.find((candidate) => candidate.id === result.track.id)!;
    expect(track).toMatchObject({ kind: "audio", name: "Voiceover" });
    if (track.kind !== "audio") throw new Error("not an audio track");
    expect(track.clips).toHaveLength(7);
    expect(track.clips[0]).toMatchObject({ type: "media", asset: "assets/voiceover/launch-vo/hook-1.wav", scriptRef: "scripts/launch-vo.md#hook" });
    expect(track.clips.at(-1)).toMatchObject({ scriptRef: "scripts/launch-vo.md#fix" });
    // The 12 ms phrase fade of #470 on both ends of every phrase, sample-accurate (#585).
    expect(track.clips.map((clip) => clip.audio)).toEqual(Array(7).fill({ fadeInMs: 12, fadeOutMs: 12 }));

    // One transaction: reverting it takes the track and every clip away.
        const { transactions } = await conn.request("history", { cwd: root, timeline: "main" });
    const last = transactions[transactions.length - 1]!;
    expect(last).toMatchObject({ tx: result.tx, label: "Voiceover: launch-vo (3 lines)" });
    expect(last.operations.map((operation) => operation.op)).toEqual(["track.add", ...Array<string>(7).fill("clip.add")]);
    await conn.request("revert", { cwd: root, timeline: "main", target: result.tx! });
    expect(timeline().tracks.some((candidate) => candidate.id === result.track.id)).toBe(false);
  });

  it("places a line at seconds, a marker with an offset, or a bar of the grid, and one phrase on its own", async () => {
    await generate();
    await conn.request("marker.add", { cwd: root, at: 5, label: "hook" });
    await conn.request("tempo.set", { cwd: root, bpm: 120 });
    const result = await place({ at: { "hook-1": "hook+0.5", "hook-1.3": 7, "hook-2": "bar:5", "fix-1": 20 } });

    const start = (line: string, phrase: number) => result.placed.find((clip) => clip.line === line && clip.phrase === phrase)!.start;
    expect(start("hook-1", 1)).toBeCloseTo(5.5, 1);
    expect(Math.abs(start("hook-1", 1) - 5.5)).toBeLessThanOrEqual(HALF_FRAME);
    // Phrase 2 follows phrase 1 at the take's spacing; phrase 3 was anchored on its own.
    expect(start("hook-1", 2)).toBeGreaterThan(start("hook-1", 1));
    expect(Math.abs(start("hook-1", 3) - 7)).toBeLessThanOrEqual(HALF_FRAME);
    // 120 bpm in 4/4: a bar is 2 s, bar 5 starts at 8 s.
    expect(Math.abs(start("hook-2", 1) - 8)).toBeLessThanOrEqual(HALF_FRAME);
    expect(Math.abs(start("fix-1", 1) - 20)).toBeLessThanOrEqual(HALF_FRAME);
    expect(result.placed.filter((clip) => clip.anchor === "at").map((clip) => `${clip.line}.${clip.phrase}`)).toEqual(["hook-1.1", "hook-1.3", "hook-2.1", "fix-1.1"]);
  });

  it("starts at `start`, else right after the voice track's last clip, and puts only the lines asked for", async () => {
    await generate();
    const early = await place({ lines: ["hook-1"], start: 2 });
    expect(early.placed[0]!.start).toBeCloseTo(2, 1);
    const end = early.placed.at(-1)!.end;
    const next = await place({ lines: ["hook-2"] });
    expect(next.lines).toEqual([expect.objectContaining({ id: "hook-2", anchor: "start" })]);
    expect(next.track).toMatchObject({ id: early.track.id, created: false });
    expect(frames(next.placed[0]!.start)).toBe(frames(end));
  });

  it("refuses a phrase that would start before the previous one ends, and one on a clip already on the track", async () => {
    await generate();
    const overlap = await rejection(place({ at: { "hook-2": 0.2 } }));
    expect(overlap.code).toBe(ErrorCode.InvalidOperation);
    expect(overlap.message).toContain("hook-2 phrase 1 would start at 0.2 s, before hook-1 phrase");
    expect(overlap.message).toContain("overlap itself");
    expect(overlap.message).toContain("script order");

    await place({ lines: ["hook-1"], start: 0 });
    const clash = await rejection(place({ lines: ["fix-1"], start: 0.3, replace: true }));
    expect(clash.message).toContain("fix-1 phrase 1");
    expect(clash.message).toContain("is already on the voice track");
    // Nothing was added by the refused calls.
    expect(timeline().tracks.flatMap((track) => (track.kind === "audio" ? track.clips : []))).toHaveLength(3);
  });

  it("fails on clips already playing the takes unless `replace`, which removes them first", async () => {
    await generate();
    const first = await place();
    const again = await rejection(place());
    expect(again.code).toBe(ErrorCode.InvalidOperation);
    expect(again.message).toContain("clips already play these takes");
    expect(again.message).toContain(first.placed[0]!.clip!);

    const replaced = await place({ replace: true });
    expect([...replaced.replaced].sort()).toEqual(first.placed.map((clip) => clip.clip!).sort());
    const clips = timeline().tracks.flatMap((track) => (track.kind === "audio" ? track.clips : []));
    expect(clips).toHaveLength(7);
    expect(clips.map((clip) => clip.id).filter((id) => first.placed.some((old) => old.clip === id))).toEqual([]);
    expect(replaced.track).toMatchObject({ id: first.track.id, created: false });
  });

  it("plays a phrase at its tempo: the clip speed, the effective length, the pause after it kept", async () => {
    await generate();
    const plain = await place({ dryRun: true });
    const result = await place({ tempo: { "hook-1.2": 1.25, "hook-1.3": 0.8, "fix-1": 1.1 } });

    expect(result.placed.map((clip) => clip.speed)).toEqual([1, 1.25, 0.8, 1, 1, 1.1, 1]);
    const [one, two, three] = result.placed;
    const length = (clip: { in: number; out: number }) => frames(clip.out) - frames(clip.in);
    // (out - in) / speed, to the millisecond; on the grid it is that rounded to whole frames.
    expect(two!.duration).toBeCloseTo(length(two!) / FPS / 1.25, 3);
    expect(three!.duration).toBeCloseTo(length(three!) / FPS / 0.8, 3);
    expect(one!.duration).toBeCloseTo(length(one!) / FPS, 3);
    // The end is the engine's: stored start plus stored (out - in) / speed, snapped to the grid.
    const engineEnd = (clip: { start: number; in: number; out: number; speed: number }) => frames(clip.start + (clip.out - clip.in) / clip.speed);
    expect(frames(two!.end)).toBe(engineEnd(two!));
    expect(frames(three!.end)).toBe(engineEnd(three!));
    // The pause the take has between two phrases keeps its length whatever tempo the phrase before plays at.
    expect(frames(two!.start) - frames(one!.end)).toBe(frames(two!.in) - frames(one!.out));
    expect(frames(three!.start) - frames(two!.end)).toBe(frames(three!.in) - frames(two!.out));
    // Same phrases, same cuts of the take as without tempo; the speed only changes what follows.
    expect(result.placed.map((clip) => [clip.in, clip.out])).toEqual(plain.placed.map((clip) => [clip.in, clip.out]));
    expect(plain.placed.map((clip) => [clip.speed, clip.duration])).toEqual(plain.placed.map((clip) => [1, clip.duration]));
    // The line ends where its last phrase now ends, and the next line follows it by the gap.
    expect(result.lines[0]!.end).toBe(three!.end);
    expect(frames(result.placed[3]!.start)).toBe(frames(three!.end) + 12);

    const written = timeline().tracks.find((candidate) => candidate.id === result.track.id)!;
    if (written.kind !== "audio") throw new Error("not an audio track");
    expect(written.clips.map((clip) => ("speed" in clip ? clip.speed : undefined))).toEqual([undefined, 1.25, 0.8, undefined, undefined, 1.1, undefined]);
    for (const [index, clip] of written.clips.entries()) {
      expect(Math.abs(clip.start - result.placed[index]!.start)).toBeLessThan(1e-6);
      expect(clip.audio).toEqual({ fadeInMs: 12, fadeOutMs: 12 });
    }
  });

  it("counts a sped phrase's end as the engine does, at tempos where rounding whole frames differs", async () => {
    // start frame 2, 31 frames from in frame 1 at 0.85: 38 by rounding frames, 39 by the engine's clipEnd.
    const grid = new FrameGrid(FPS);
    expect(phraseEnd(grid, 2, 1, 32, 0.85)).toBe(39);
    const nested = async () => 0;
    for (const speed of [0.85, 0.9, 1.15, 1.25]) {
      for (let start = 0; start < 60; start += 7) {
        for (let inFrame = 0; inFrame < 40; inFrame += 3) {
          for (let length = 1; length < 60; length++) {
            const clip = { id: "c", asset: "a", start: grid.seconds(start), in: grid.seconds(inFrame), out: grid.seconds(inFrame + length), speed };
            const engine = Math.max(start + 1, grid.frame(await clipEnd(clip as never, grid, nested)));
            expect(phraseEnd(grid, start, inFrame, inFrame + length, speed)).toBe(engine);
          }
        }
      }
    }

    await generate();
    for (const speed of [0.85, 1.15]) {
      const result = await place({ replace: true, tempo: { "hook-1": speed, "hook-1.2": speed, "hook-1.3": speed, "hook-2": speed, "hook-2.2": speed, "fix-1": speed, "fix-1.2": speed } });
      const written = timeline().tracks.find((candidate) => candidate.id === result.track.id)!;
      if (written.kind !== "audio") throw new Error("not an audio track");
      for (const [index, clip] of written.clips.entries()) {
        expect(frames(await clipEnd(clip as never, grid, nested))).toBe(frames(result.placed[index]!.end));
      }
    }
  });

  it("anchors on a marker work with tempo, and a faster phrase makes room for the next anchor", async () => {
    await generate();
    const slow = await place({ dryRun: true, tempo: { "hook-1.1": 0.8, "hook-1.2": 0.8, "hook-1.3": 0.8 } });
    const fast = await place({ dryRun: true, tempo: { "hook-1.1": 1.25, "hook-1.2": 1.25, "hook-1.3": 1.25 } });
    expect(slow.lines[0]!.end).toBeGreaterThan(fast.lines[0]!.end);
    // An anchor between the two ends fits the fast line and crosses the slow one.
    const between = (slow.lines[0]!.end + fast.lines[0]!.end) / 2;
    expect((await place({ dryRun: true, at: { "hook-2": between }, tempo: { "hook-1.1": 1.25, "hook-1.2": 1.25, "hook-1.3": 1.25 } })).placed[3]!.start).toBeCloseTo(between, 1);
    const crossed = await rejection(place({ dryRun: true, at: { "hook-2": between }, tempo: { "hook-1.1": 0.8, "hook-1.2": 0.8, "hook-1.3": 0.8 } }));
    expect(crossed.code).toBe(ErrorCode.InvalidOperation);
    expect(crossed.message).toContain("overlap itself");
  });

  it("names a `tempo` key that is no line or phrase, one given twice, and a tempo out of range", async () => {
    await generate();
    const key = await rejection(place({ tempo: { "hook-9": 1.1 } }));
    expect(key.code).toBe(ErrorCode.InvalidParams);
    expect(key.message).toContain("`tempo` names hook-9");
    const phrase = await rejection(place({ tempo: { "hook-2.3": 1.1 } }));
    expect(phrase.message).toContain("`tempo` names phrase 3 of hook-2, which has 2 phrases");
    const twice = await rejection(place({ tempo: { "hook-1": 1.1, "hook-1.1": 0.9 } }));
    expect(twice.message).toContain("`tempo` gives hook-1 phrase 1 twice");
    for (const value of [0.79, 1.26, 2, 0]) {
      expect((await rejection(place({ tempo: { "hook-1": value } }))).code).toBe(ErrorCode.InvalidParams);
    }
    // Nothing was written by the refused calls.
    expect(timeline().tracks.filter((track) => track.kind === "audio")).toHaveLength(0);
  });

  it("plans a dry run without writing anything", async () => {
    await generate();
    const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
    const result = await place({ dryRun: true, at: { "hook-2": 10 } });
    expect(result).toMatchObject({ dryRun: true, tx: null, track: { id: null, created: true } });
    expect(result.placed).toHaveLength(7);
    expect(result.placed.every((clip) => clip.clip === null)).toBe(true);
    expect(readFileSync(join(root, "timelines", "main.json"), "utf8")).toBe(before);
  });

  it("names the lines with no take, an unknown marker, an unknown `at` key and a track that is not audio", async () => {
    const none = await rejection(place());
    expect(none.code).toBe(ErrorCode.InvalidOperation);
    expect(none.message).toContain("no take for hook-1, hook-2, fix-1");

    await generate();
    const marker = await rejection(place({ at: { "hook-1": "nowhere" } }));
    expect(marker.code).toBe(ErrorCode.InvalidOperation);
    expect(marker.message).toContain('"nowhere" is neither seconds nor a marker');
    expect(marker.data).toMatchObject({ field: "at.hook-1" });

    const key = await rejection(place({ at: { "hook-9": 1 } }));
    expect(key.code).toBe(ErrorCode.InvalidParams);
    expect(key.message).toContain("hook-9");
    const phrase = await rejection(place({ at: { "hook-2.3": 1 } }));
    expect(phrase.message).toContain("phrase 3 of hook-2, which has 2 phrases");
    const twice = await rejection(place({ at: { "hook-1": 1, "hook-1.1": 2 } }));
    expect(twice.message).toContain("twice");

    const video = (await conn.request("track.add", { cwd: root, kind: "video" })).changes.added[0]!;
    const wrong = await rejection(place({ track: video }));
    expect(wrong.message).toContain("is a video track; the voice goes on an audio track");
  });

  it("a beat reference needs a tempo, like every other time argument", async () => {
    await generate();
    const refused = await rejection(place({ at: { "hook-1": "beat:3" } }));
    expect(refused.code).toBe(ErrorCode.InvalidOperation);
    expect(refused.message).toContain("the timeline has no tempo");
  });

  it("warns about a take said from older text, and generate warns when it replaced a take a clip plays", async () => {
    await generate();
    await place({ lines: ["hook-1"] });
    writeFileSync(join(root, "scripts", "launch-vo.md"), script(["## Hook", "Eight nine.", "Four five.", "## Fix", "Six seven."]));
    const stale = await place({ lines: ["hook-1"], replace: true });
    expect(stale.warnings.some((warning) => warning.includes("Line hook-1: its take was said from older text"))).toBe(true);

    const regenerated = await generate();
    expect(regenerated.lines.find((line) => line.id === "hook-1")!.state).toBe("generated");
    const warning = regenerated.warnings.find((text) => text.includes("hook-1.wav was replaced by other speech"));
    expect(warning).toContain("clips play it");
    expect(warning).toContain("voiceover place --replace");
    // Lines whose take no clip plays say nothing.
    expect(regenerated.warnings.filter((text) => text.includes("was replaced by other speech"))).toHaveLength(1);
  });
});
