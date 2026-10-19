import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type MulticamDirectResult, connectToDaemon } from "@frameshell/protocol";
import type { ProgramTrack, Timeline } from "@frameshell/schema";
import { type Daemon, ENERGY_DIR, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeVoiceClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `multicam.direct` through a real daemon: two synthetic mics, Ana then Ben then Ana, each bleeding into the other at -20 dB.
const MEDIA_TIMEOUT = 180_000;

type Burst = readonly [number, number, number];
const ANA: Burst[] = [
  [0.5, 5, 440],
  [11, 2.5, 440],
];
const BEN: Burst[] = [[6, 4.5, 550]];

let daemon: Daemon;
let agent: DaemonConnection;
let app: DaemonConnection;
let project: string;
let group: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  agent = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  app = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  project = tempDir();
  await agent.request("project.init", { dir: project });
  const footage = tempDir();
  await makeVoiceClip(join(footage, "ana.mp4"), { own: ANA, bleed: BEN });
  await makeVoiceClip(join(footage, "ben.mp4"), { own: BEN, bleed: ANA });
  const { imported } = await agent.request("asset.import", { cwd: project, files: [join(footage, "ana.mp4"), join(footage, "ben.mp4")] });
  const created = await agent.request("multicam.create", { cwd: project, assets: imported.map((entry) => entry.asset), names: ["Ana", "Ben"] });
  group = created.group;
  // Set by hand so the test does not depend on the audio sync.
  await agent.request("multicam.offset", { cwd: project, group, angle: "ben", offset: 0 });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  agent.close();
  app.close();
  await daemon.close();
});

async function program(dir = project): Promise<ProgramTrack> {
  const parsed = JSON.parse(await readFile(join(dir, "timelines", "main.json"), "utf8")) as Timeline;
  return parsed.tracks.find((track): track is ProgramTrack => track.kind === "program" && track.group === group)!;
}

/** `[layout, angles]` per shot, in order. */
const pictures = (track: ProgramTrack) => track.clips.map((shot) => `${shot.shot} ${shot.angles.join(",")}`);

describe("multicam.direct", () => {
  let first: MulticamDirectResult;

  it("cuts to whoever speaks, in one journaled operation, every shot with a confidence and reason", async () => {
    first = await agent.request("multicam.direct", { cwd: project, group });
    expect(first).toMatchObject({ group, template: "interview", rulesFile: null, kept: [], low: [] });
    const track = await program();
    expect(first.track).toBe(track.id);
    expect(pictures(track)).toEqual(["solo ana", "solo ben", "solo ana"]);
    expect(first.shots).toBe(3);
    expect(track.clips.every((shot) => shot.confidence !== undefined && shot.confidence >= 0.5 && shot.reason !== undefined)).toBe(true);
    // Ben starts at 6 s, and the cut lands 0.3 s into his turn (interview cut lead).
    expect(track.clips[1]!.start).toBeGreaterThan(6.1);
    expect(track.clips[1]!.start).toBeLessThan(6.5);
    expect(first.operation.args["turns"]).toBe(3);
    const history = await agent.request("history", { cwd: project });
    const ops = history.transactions.flatMap((tx) => tx.operations);
    expect(ops.filter((op) => op.op === "multicam.direct")).toHaveLength(1);
    expect(ops.at(-1)!.op).toBe("multicam.direct");
  }, MEDIA_TIMEOUT);

  it("gives the same shots when run again", async () => {
    const before = (await program()).clips.map(({ id: _id, ...shot }) => shot);
    await agent.request("multicam.direct", { cwd: project, group });
    expect((await program()).clips.map(({ id: _id, ...shot }) => shot)).toEqual(before);
  }, MEDIA_TIMEOUT);

  it("keeps a shot the person chose in the app, unless told to replace it", async () => {
    const ben = (await program()).clips[1]!;
    await app.request("shot.set", { cwd: project, clip: ben.id, shot: "two-up", angles: ["ana", "ben"] });
    const chosen = (await program()).clips[1]!;

    const kept = await agent.request("multicam.direct", { cwd: project, group });
    expect(kept.kept).toEqual([ben.id]);
    expect((await program()).clips.find((shot) => shot.id === ben.id)).toEqual(chosen);
    expect(pictures(await program())).toEqual(["solo ana", "two-up ana,ben", "solo ana"]);

    const replaced = await agent.request("multicam.direct", { cwd: project, group, replaceHuman: true });
    expect(replaced.kept).toEqual([]);
    expect(pictures(await program())).toEqual(["solo ana", "solo ben", "solo ana"]);
  }, MEDIA_TIMEOUT);

  it("reports only the kept shots inside the range", async () => {
    const last = (await program()).clips[2]!;
    await app.request("shot.set", { cwd: project, clip: last.id, shot: "two-up", angles: ["ana", "ben"] });
    const narrowed = await agent.request("multicam.direct", { cwd: project, group, from: 0, to: 5 });
    expect(narrowed.kept).toEqual([]);
    const whole = await agent.request("multicam.direct", { cwd: project, group });
    expect(whole.kept).toEqual([last.id]);
  }, MEDIA_TIMEOUT);

  it("keeps a shot the person sets while the turns are still being measured", async () => {
    // A copy without the envelope cache decodes every angle again, so the app's change lands first.
    // Ingest jobs of earlier tests may still be writing proxies, thumbs and waveforms: copying them races their rename.
    const skipped = [join(...ENERGY_DIR.split("/")), ...["proxies", "thumbs", "waveforms"].map((area) => join(".frameshell", area))];
    const copy = tempDir();
    await cp(project, copy, { recursive: true, filter: (path) => !skipped.some((dir) => path.includes(dir)) });
    const ben = (await program(copy)).clips[1]!;
    const directing = agent.request("multicam.direct", { cwd: copy, group });
    const set = await app.request("shot.set", { cwd: copy, clip: ben.id, shot: "two-up", angles: ["ana", "ben"] });
    const directed = await directing;
    expect(directed.operation.revisionBefore).toBeGreaterThan(set.operation.revisionBefore);
    expect(directed.kept).toContain(ben.id);
    expect((await program(copy)).clips.find((shot) => shot.id === ben.id)).toMatchObject({ shot: "two-up", angles: ["ana", "ben"] });
  }, MEDIA_TIMEOUT);

  it("reads director.json on top of the template, and refuses a broken or missing rules file", async () => {
    await writeFile(join(project, "director.json"), JSON.stringify({ template: "podcast-calm", minShot: 20 }));
    const calm = await agent.request("multicam.direct", { cwd: project, group });
    expect(calm).toMatchObject({ template: "podcast-calm", rulesFile: "director.json", shots: 1 });
    const overridden = await agent.request("multicam.direct", { cwd: project, group, template: "panel-dynamic" });
    expect(overridden.template).toBe("panel-dynamic");

    await writeFile(join(project, "director.json"), JSON.stringify({ minShots: 2 }));
    await expect(agent.request("multicam.direct", { cwd: project, group })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("director.json"),
    });
    await rm(join(project, "director.json"));
    await expect(agent.request("multicam.direct", { cwd: project, group, rules: "rules/nope.json" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ field: "rules" }),
    });
    await expect(agent.request("multicam.direct", { cwd: project, group: "g_nope" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ groups: [group] }),
    });
  }, MEDIA_TIMEOUT);
});

describe("painted turns", () => {
  const spans = (turns: { angle: string; start: number; end: number }[], angle: string) =>
    turns.filter((turn) => turn.angle === angle).map((turn) => [Math.round(turn.start * 10) / 10, Math.round(turn.end * 10) / 10]);

  it("override the measured ones for multicam.turns and multicam.direct, and null gives them back", async () => {
    const measured = await agent.request("multicam.turns", { cwd: project, group });
    const ben = spans(measured.turns, "ben");
    expect(ben).toHaveLength(1);

    // Ben's turn is 6-10.5 s: hand 7-9 s to Ana, who is silent there by sound.
    await app.request("multicam.paint", { cwd: project, group, angle: "ana", start: 7, end: 9, speaking: true, alone: true });
    const painted = await agent.request("multicam.turns", { cwd: project, group });
    expect(spans(painted.turns, "ana")).toContainEqual([7, 9]);
    expect(spans(painted.turns, "ben")).toEqual([
      [ben[0]![0], 7],
      [9, ben[0]![1]],
    ]);

    const directed = await agent.request("multicam.direct", { cwd: project, group, replaceHuman: true });
    const track = await program();
    const at = (second: number) => track.clips.find((shot) => shot.in <= second && second < shot.out)!;
    expect(at(8).angles).toEqual(["ana"]);
    expect(directed.operation.args["turns"]).toBe(painted.turns.length);

    await app.request("multicam.paint", { cwd: project, group, start: 0, end: 20, speaking: null });
    const back = await agent.request("multicam.turns", { cwd: project, group });
    expect(spans(back.turns, "ben")).toEqual(ben);
    expect(spans(back.turns, "ana")).not.toContainEqual([7, 9]);
  }, MEDIA_TIMEOUT);
});
