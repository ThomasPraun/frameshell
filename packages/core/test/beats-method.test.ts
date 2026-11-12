import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { effectiveBeatGrid, parseBeatsFile } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { clickTime, clickTrack, wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `beats.measure` and `beats.show` through a real daemon and managed ffmpeg: a click track is imported, its
// ingest finishes (so the 48 kHz sidecar is the source), and the grid lands in beats/ within 15 ms.
const MEDIA_TIMEOUT = 240_000;
const TRACK = { bpm: 120, seconds: 20, offset: 0.2 };
let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const footage = tempDir();
  writeFileSync(join(footage, "loop.wav"), wavOf(clickTrack(TRACK), 48_000));
  writeFileSync(join(footage, "quiet.wav"), wavOf(new Float32Array(48_000 * 8), 48_000));
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "-y", join(footage, "logo.png")]);
  await conn.request("asset.import", { cwd: project, files: ["loop.wav", "quiet.wav", "logo.png"].map((name) => join(footage, name)) });
  // The sidecar exists once the ingest is done; wait for it so the measure reads the 48 kHz source.
  for (let tries = 0; tries < 200; tries++) {
    const { assets } = await conn.request("asset.list", { cwd: project });
    if (assets.length === 3 && assets.every((asset) => asset.state === "ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("ingest did not finish");
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

const fileOf = (rel: string) => parseBeatsFile(JSON.parse(readFileSync(join(project, ...rel.split("/")), "utf8")));
const write = (rel: string, content: string) => conn.request("file.write", { path: join(project, ...rel.split("/")), content });

describe("beats.measure and beats.show", () => {
  it(
    "writes beats/<name>.beats.json within 15 ms of the clicks, as a beats job, and shows it back",
    async () => {
      const progress: string[] = [];
      const result = await conn.request("beats.measure", { cwd: project, asset: "assets/loop.wav" }, { onProgress: (update) => progress.push(update.stage ?? "") });
      expect(methods["beats.measure"].result.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        asset: "assets/loop.wav",
        file: "beats/loop.beats.json",
        detector: "onset-flux@1",
        meter: 4,
        low: false,
        sampleRate: 48_000,
        cached: false,
        keptEdits: false,
        alternatives: [],
      });
      expect(result.bpm).toBeCloseTo(120, 0);
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.residualMs).toBeLessThan(15);

      const parsed = fileOf(result.file);
      expect(parsed.ok).toBe(true);
      const file = parsed.ok ? parsed.value : null;
      expect(file!.assetHash).toBe(result.hash);
      expect(file!.beats).toHaveLength(result.beatCount);
      for (const [index, time] of file!.beats.entries()) {
        expect(Math.abs(time - clickTime(TRACK, Math.round(((time - TRACK.offset) * TRACK.bpm) / 60)))).toBeLessThan(0.015);
        if (index > 0) expect(time).toBeGreaterThan(file!.beats[index - 1]!);
      }
      expect(existsSync(join(project, ".frameshell", "beats"))).toBe(true);

      const jobs = await conn.request("job.list", { cwd: project });
      expect(jobs.jobs.filter((job) => job.kind === "beats")).toEqual([expect.objectContaining({ asset: "assets/loop.wav", state: "done", step: null })]);

      const shown = await conn.request("beats.show", { cwd: project, asset: join(project, "assets", "loop.wav") });
      expect(methods["beats.show"].result.parse(shown)).toEqual(shown);
      expect(shown).toMatchObject({ file: result.file, current: true, edits: {}, low: false });
      expect(shown.beats).toEqual(file!.beats);
      expect(shown.downbeats.length).toBe(Math.ceil(shown.beats.length / 4));
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps human edits across a new measure (reusing the cached envelope) unless told to reset, and shows them applied",
    async () => {
      const parsed = fileOf("beats/loop.beats.json");
      if (!parsed.ok) throw new Error(parsed.error);
      const edited = { ...parsed.value, edits: { tempo: "half" as const, downbeat: 1 } };
      await write("beats/loop.beats.json", JSON.stringify(edited));
      const halved = await conn.request("beats.show", { cwd: project, asset: "assets/loop.wav" });
      expect(halved.bpm).toBeCloseTo(60, 0);
      expect(halved.beats).toEqual(effectiveBeatGrid(edited).beats);
      expect(halved.beats).toHaveLength(Math.ceil(parsed.value.beats.length / 2));
      expect(halved.downbeats[0]).toBe(halved.beats[1]);

      const kept = await conn.request("beats.measure", { cwd: project, asset: "assets/loop.wav", bpm: 120 });
      expect(kept).toMatchObject({ cached: true, keptEdits: true, bpm: 60 });
      const reset = await conn.request("beats.measure", { cwd: project, asset: "assets/loop.wav", resetEdits: true });
      expect(reset).toMatchObject({ keptEdits: false });
      expect(reset.bpm).toBeCloseTo(120, 0);
      const again = fileOf("beats/loop.beats.json");
      expect(again.ok && again.value.edits).toEqual({});
    },
    MEDIA_TIMEOUT,
  );

  it("validates a hand-written beats file: a broken one is rejected and the old one kept", async () => {
    const before = readFileSync(join(project, "beats", "loop.beats.json"), "utf8");
    await expect(write("beats/loop.beats.json", '{"asset": "assets/loop.wav", "beats": [2, 1]}')).rejects.toMatchObject({ code: ErrorCode.InvalidProjectFile });
    expect(readFileSync(join(project, "beats", "loop.beats.json"), "utf8")).toBe(before);
    // A generator that knows its beats writes the same file with detector `exact`.
    const exact = { schemaVersion: 1, asset: "assets/generated.wav", assetHash: `sha256:${"0".repeat(64)}`, detector: "exact", bpm: 100, confidence: 1, beats: [0, 0.6, 1.2] };
    await expect(write("beats/generated.beats.json", JSON.stringify(exact))).resolves.toMatchObject({ path: "beats/generated.beats.json" });
  });

  it("refuses silence, an asset without audio, a missing file and a grid that was never measured", async () => {
    await expect(conn.request("beats.measure", { cwd: project, asset: "assets/quiet.wav" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "no beats" }),
    });
    await expect(conn.request("beats.measure", { cwd: project, asset: "assets/logo.png" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "no audio" }),
    });
    await expect(conn.request("beats.measure", { cwd: project, asset: "assets/none.wav" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    await expect(conn.request("beats.show", { cwd: project, asset: "assets/quiet.wav" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "not measured" }),
    });
  });

  it(
    "gc sweeps the onset envelope of a deleted asset and never the beats file",
    async () => {
      const kept = await conn.request("gc", { cwd: project, dryRun: true });
      expect(kept.removed.filter((entry) => entry.kind === "beats")).toEqual([]);
      rmSync(join(project, "assets", "loop.wav"), { force: true });
      const swept = await conn.request("gc", { cwd: project, dryRun: false });
      expect(swept.removed.filter((entry) => entry.kind === "beats").map((entry) => entry.path)).toEqual([expect.stringMatching(/^\.frameshell\/beats\/[0-9a-f]{20}-b1-22050\.f32$/)]);
      expect(swept.removed.some((entry) => entry.path.startsWith("beats/"))).toBe(false);
      expect(existsSync(join(project, "beats", "loop.beats.json"))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );
});
