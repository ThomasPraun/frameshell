import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `shoot.assemble` (ADR 0023 decision 6) through a real daemon, real synthetic media and
// hand-written transcripts, so the take's word times are known exactly.

const SCRIPT = ["---", "shoot: true", "---", "## Hook", "Hola a todos", "[VISUAL: logo]", "## Problem", "Ninguna la vas a leer"].join("\n");
const SCRIPT_PATH = "scripts/launch.md";

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

/** A take: an 8 s clip and its transcript, `[text, start]` per word, each word 0.35 s long. */
async function take(name: string, words: [string, number][]) {
  const file = join(root, "assets", `${name}.mp4`);
  await makeClip(file, { durationS: 8 });
  const transcript = {
    schemaVersion: 1,
    asset: `assets/${name}.mp4`,
    assetHash: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    provider: "test",
    model: "test",
    language: "es",
    words: words.map(([text, start], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end: start + 0.35 })),
  };
  writeFileSync(join(root, "transcripts", `${name}.words.json`), JSON.stringify(transcript));
  return (await conn.request("shoot.add", { cwd: root, script: SCRIPT_PATH, asset: `assets/${name}.mp4` })).take.id;
}

const clipsOf = async () => {
  const shown = await conn.request("timeline.show", { cwd: root, timeline: "launch" });
  return shown.tracks.flatMap((track) => track.clips.map((clip) => ({ ...(clip as Record<string, unknown>), track: track.id }))) as Record<string, unknown>[];
};

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "transcripts"), { recursive: true });
  writeFileSync(join(root, SCRIPT_PATH), SCRIPT);
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("shoot.assemble", () => {
  it("places each scene's chosen take in script order, cutting restarts and long pauses, with handles", async () => {
    const first = await take("one", [
      ["hola", 1.0], ["a", 1.4], ["todos", 1.8],
      ["ninguna", 3.0], ["la", 3.4],
      ["ninguna", 4.0], ["la", 4.4], ["vas", 4.8], ["a", 7.0], ["leer", 7.4],
    ]);
    const result = await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false });
    expect(result).toMatchObject({ timeline: "launch", created: true, tx: expect.any(String) });
    expect(result.scenes.map((scene) => [scene.slug, scene.action, scene.clips.length])).toEqual([
      ["hook", "placed", 1],
      ["problem", "placed", 2],
    ]);
    const clips = await clipsOf();
    expect(clips.map((clip) => [clip.scriptRef, clip.take])).toEqual([
      [`${SCRIPT_PATH}#hook`, first],
      [`${SCRIPT_PATH}#problem`, first],
      [`${SCRIPT_PATH}#problem`, first],
    ]);
    // Hook 0.85-2.3; problem from 3.85 (the restart at 3.0 is before it) to 5.3, pause cut, then 6.85-7.9.
    const wanted: [number, number][] = [[0.85, 2.3], [3.85, 5.3], [6.85, 7.9]];
    clips.forEach((clip, i) => {
      expect(clip.in as number).toBeCloseTo(wanted[i]![0], 1);
      expect(clip.out as number).toBeCloseTo(wanted[i]![1], 1);
    });
    expect(clips[0]!.start).toBe(0);
    expect(clips[1]!.start as number).toBeCloseTo(clips[0]!.out as number - (clips[0]!.in as number), 1);

    const status = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
    expect(status.cues).toMatchObject([{ label: "VISUAL", time: expect.closeTo(1.3, 1) }]);
    expect((await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false })).scenes.map((scene) => scene.action)).toEqual(["unchanged", "unchanged"]);
  }, 120_000);

  it("swaps a scene to a newer take, moves what follows and keeps the person's own clips", async () => {
    await take("one", [["hola", 1.0], ["a", 1.4], ["todos", 1.8], ["ninguna", 3.0], ["la", 3.4], ["vas", 3.8], ["a", 4.2], ["leer", 4.6]]);
    await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false });
    const before = await clipsOf();
    const track = before[0]!.track as string;
    // The person's clip, after the hook on the same track.
    await makeClip(join(root, "assets", "broll.mp4"), { durationS: 1 });
    const problemStart = before[1]!.start as number;
    const theirs = await conn.request("clip.add", { cwd: root, timeline: "launch", track, type: "media", asset: "assets/broll.mp4", start: problemStart + 3 });
    const theirId = theirs.changes.added[0]!;

    const second = await take("two", [["hola", 0.5], ["a", 0.9], ["todos", 1.3], ["hola", 2.0], ["a", 2.4], ["todos", 2.8], ["che", 3.2]]);
    const result = await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false });
    expect(result.scenes.map((scene) => [scene.slug, scene.take, scene.action])).toEqual([
      ["hook", second, "placed"],
      ["problem", expect.any(String), "unchanged"],
    ]);
    const after = await clipsOf();
    const hook = after.find((clip) => clip.take === second)!;
    const problem = after.find((clip) => clip.scriptRef === `${SCRIPT_PATH}#problem`)!;
    const hookLength = (hook.out as number) - (hook.in as number);
    expect(problem.start as number).toBeCloseTo(hookLength, 1);
    const mine = after.find((clip) => clip.id === theirId)!;
    expect(mine.start as number).toBeCloseTo((problem.start as number) + 3, 1);

    await conn.request("revert", { cwd: root, timeline: "launch", target: result.tx! });
    expect((await clipsOf()).map((clip) => [clip.id, clip.start])).toEqual(before.map((clip) => [clip.id, clip.start]).concat([[theirId, problemStart + 3]]).sort((a, b) => (a[1] as number) - (b[1] as number)));
  }, 120_000);

  it("snaps edges into pauses by default", async () => {
    await take("one", [["hola", 1.0], ["a", 1.4], ["todos", 1.8], ["ninguna", 3.0], ["la", 3.4], ["vas", 3.8], ["a", 4.2], ["leer", 4.6]]);
    const result = await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH });
    expect(result.scenes.map((scene) => scene.action)).toEqual(["placed", "placed"]);
    const clips = await clipsOf();
    expect(clips).toHaveLength(2);
    expect(clips[1]!.start as number).toBeCloseTo((clips[0]!.out as number) - (clips[0]!.in as number), 2);
  }, 120_000);
});
