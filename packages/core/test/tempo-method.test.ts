import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DaemonConnection, ErrorCode, type EventParams, connectToDaemon, methods } from "@frameshell/protocol";
import { type BeatsFile, parseTimeline } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// `tempo.set`, `tempo.show`, `timeline.show` with `grid`, `snapTo` and `beats.changed` through a real daemon (ADR 0029
// slice 3). The music is a silent WAV; its beat grid is a hand-written `exact` beats file (120 BPM, a beat every 0.5 s
// from 0.5 s, a bar every 4), so nothing here depends on the detector.
const MEDIA_TIMEOUT = 120_000;
const BEATS_PATH = "beats/music.beats.json";
const beatsFile = (overrides: Partial<BeatsFile> = {}): BeatsFile => ({
  schemaVersion: 1,
  asset: "assets/music.wav",
  assetHash: `sha256:${"0".repeat(64)}`,
  detector: "exact",
  bpm: 120,
  meter: 4,
  downbeat: 0,
  confidence: 1,
  beats: Array.from({ length: 40 }, (_, index) => 0.5 + index * 0.5),
  edits: {},
  ...overrides,
});

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let music = "";

const write = (rel: string, content: string) => {
  const path = join(project, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const request = <K extends Parameters<DaemonConnection["request"]>[0]>(method: K, params: Record<string, unknown> = {}) =>
  conn.request(method, { cwd: project, ...params } as never) as Promise<never>;
const timelineFile = () => JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8"));
const show = (): Promise<EventParams<"beats.changed"> & { grid: { beats: number[]; bars: number[]; bpm: number; low: boolean; source: string } | null; problem: string | null; tempo: unknown }> =>
  request("tempo.show") as never;

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
  const footage = tempDir();
  writeFileSync(join(footage, "music.wav"), wavOf(new Float32Array(48_000 * 12), 48_000));
  await conn.request("asset.import", { cwd: project, files: [join(footage, "music.wav")] });
  await request("track.add", { kind: "audio" });
  const { tracks } = (await request("track.list")) as { tracks: { id: string }[] };
  const added = (await request("clip.add", { track: tracks[0]!.id, asset: "assets/music.wav", start: 2, out: 10 })) as { changes: { added: string[] } };
  music = added.changes.added[0]!;
  write(BEATS_PATH, JSON.stringify(beatsFile()));
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("tempo.show and tempo.set", () => {
  it("has no tempo to begin with, and says how to set one", async () => {
    const shown = await show();
    expect(methods["tempo.show"].result.parse(shown)).toEqual(shown);
    expect(shown).toMatchObject({ tempo: null, grid: null, problem: null });
  });

  it("follows a music clip: the beats file's grid on the timeline clock, bars every four beats", async () => {
    const set = (await request("tempo.set", { clip: music })) as { operation: { op: string; args: Record<string, unknown> }; revision: number };
    expect(set.operation).toMatchObject({ op: "tempo.set", args: { clip: music } });
    expect(timelineFile().tempo).toEqual({ clip: music });
    const { grid, tempo } = await show();
    expect(tempo).toEqual({ clip: music });
    // The clip plays source 0–10 s at timeline 2: beat 0.5 → 2.5 …, and the last source beat before 10 s is 9.5 → 11.5.
    expect(grid).toMatchObject({ source: "beats", bpm: 120, meter: 4, low: false });
    expect(grid!.beats.slice(0, 4)).toEqual([2.5, 3, 3.5, 4]);
    expect(grid!.beats.at(-1)).toBe(11.5);
    expect(grid!.bars).toEqual([2.5, 4.5, 6.5, 8.5, 10.5]);
  });

  it("timeline.show carries the stored tempo, and the grid only on request", async () => {
    const plain = (await request("timeline.show")) as { tempo?: unknown; grid?: unknown };
    expect(plain.tempo).toEqual({ clip: music });
    expect(plain).not.toHaveProperty("grid");
    const withGrid = (await request("timeline.show", { grid: true })) as { grid?: { beats: number[] }; gridProblem?: string };
    expect(withGrid.grid!.beats[0]).toBe(2.5);
    expect(withGrid).not.toHaveProperty("gridProblem");
  });

  it("moves the grid with the music clip", async () => {
    await request("clip.move", { clip: music, start: 5 });
    expect((await show()).grid!.beats.slice(0, 2)).toEqual([5.5, 6]);
    await request("clip.move", { clip: music, start: 2 });
  });

  it("snapTo moves each time argument onto the nearest beat or bar, and the journal records the seconds", async () => {
    const added = (await request("marker.add", { at: 3.3, label: "drop", snapTo: "beat" })) as { operation: { args: Record<string, unknown> } };
    expect(added.operation.args).toEqual({ at: 3.5, label: "drop" });
    const set = (await request("marker.set", { marker: "drop", at: "drop+0.9", snapTo: "bar" })) as { operation: { args: Record<string, unknown> } };
    expect(set.operation.args).toMatchObject({ at: 4.5 });
    expect(timelineFile().markers).toEqual([expect.objectContaining({ label: "drop", at: 4.5 })]);
    const split = (await request("clip.split", { clip: music, at: 6.1, snapTo: "beat" })) as { operation: { args: Record<string, unknown>; tx: string } };
    expect(split.operation.args).toMatchObject({ at: 6 });
    await request("revert", { target: split.operation.tx });
    await request("marker.remove", { marker: "drop" });
  });

  it("snapTo refuses a time far outside the music, and without a tempo", async () => {
    await expect(request("marker.add", { at: 40, label: "late", snapTo: "beat" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("outside the grid"),
      data: expect.objectContaining({ reason: "snap", field: "snapTo" }),
    });
    await request("tempo.set", { clear: true });
    await expect(request("marker.add", { at: 3, label: "x", snapTo: "beat" })).rejects.toMatchObject({
      message: expect.stringContaining("no tempo"),
    });
    expect(timelineFile()).not.toHaveProperty("tempo");
    await request("tempo.set", { clip: music });
  });

  it("a nominal tempo needs no music: beats from a BPM, blockable from an empty timeline", async () => {
    await request("tempo.set", { bpm: 90, offset: 1, meter: 3 });
    const { grid } = await show();
    expect(grid).toMatchObject({ source: "nominal", bpm: 90, meter: 3 });
    expect(grid!.beats.slice(0, 3)).toEqual([1, 1.667, 2.333]);
    expect(grid!.bars.slice(0, 2)).toEqual([1, 3]);
    const snapped = (await request("marker.add", { at: 1.9, label: "nominal", snapTo: "beat" })) as { operation: { args: Record<string, unknown> } };
    expect(snapped.operation.args).toMatchObject({ at: 1.667 });
    await request("marker.remove", { marker: "nominal" });
    await request("tempo.set", { clip: music });
  });

  it("beat:N and bar:N name grid times on every method with a time (ADR 0029 slice 4), and the journal records seconds", async () => {
    // The music plays source 0–10 s at timeline 2, so beat 1 is 2.5 s and the bars start at 2.5, 4.5, 6.5, …
    const bar = (await request("marker.add", { at: "bar:2", label: "verse" })) as { operation: { args: Record<string, unknown> } };
    expect(bar.operation.args).toEqual({ at: 4.5, label: "verse" });
    const beat = (await request("marker.add", { at: "beat:3-0.5", label: "lead" })) as { operation: { args: Record<string, unknown> } };
    expect(beat.operation.args).toMatchObject({ at: 3 });
    const split = (await request("clip.split", { clip: music, at: "bar:3", snapTo: "beat" })) as { operation: { args: Record<string, unknown>; tx: string } };
    expect(split.operation.args).toMatchObject({ at: 6.5 });
    await request("revert", { target: split.operation.tx });
    await request("marker.remove", { marker: "verse" });
    await request("marker.remove", { marker: "lead" });
  });

  it("beat:N carries on past the music at the tempo, and refuses a missing tempo like --snap-to does", async () => {
    // The clip shows file beats 1..19 (source 0.5–9.5 s); beat 30 is source 15 s, timeline 17.
    const late = (await request("marker.add", { at: "beat:30", label: "late" })) as { operation: { args: Record<string, unknown> } };
    expect(late.operation.args).toMatchObject({ at: 17 });
    await request("marker.remove", { marker: "late" });
    await request("tempo.set", { clear: true });
    await expect(request("marker.add", { at: "bar:2", label: "x" })).rejects.toMatchObject({ message: expect.stringContaining("the timeline has no tempo") });
    await request("tempo.set", { clip: music });
    expect(timelineFile().markers ?? []).toEqual([]);
  });
});

describe("a beats file edited by hand", () => {
  it("sends beats.changed, and the grid follows: half time, a broken file, a repaired one, a missing one", async () => {
    const watcher = await connectToDaemon(daemon.socketPath, { client: "desktop/watch" });
    try {
      await watcher.request("events.subscribe", { cwd: project, events: ["beats.changed"] });
      const seen: EventParams<"beats.changed">[] = [];
      watcher.on("beats.changed", (params) => seen.push(params));
      // The daemon attaches its watch when the project opens, a moment ago; give it time to be ready.
      await new Promise((resolve) => setTimeout(resolve, 600));

      write(BEATS_PATH, JSON.stringify(beatsFile({ edits: { tempo: "half" } })));
      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ file: BEATS_PATH, change: "written", project }), { timeout: 8_000 });
      const half = await show();
      expect(half.grid!.bpm).toBe(60);
      expect(half.grid!.beats.slice(0, 3)).toEqual([2.5, 3.5, 4.5]);

      write(BEATS_PATH, '{ "asset": "assets/music.wav", "beats": [2, 1] }');
      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ file: BEATS_PATH, change: "invalid", message: expect.stringContaining("Invalid") }), { timeout: 8_000 });
      const broken = await show();
      expect(broken.grid).toBeNull();
      expect(broken.problem).toContain("Invalid");
      const view = (await request("timeline.show", { grid: true })) as { grid?: unknown; gridProblem?: string };
      expect(view.grid).toBeUndefined();
      expect(view.gridProblem).toContain("Invalid");

      write(BEATS_PATH, JSON.stringify(beatsFile()));
      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ change: "written" }), { timeout: 8_000 });
      expect((await show()).grid!.bpm).toBe(120);

      rmSync(join(project, ...BEATS_PATH.split("/")));
      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ change: "removed" }), { timeout: 8_000 });
      const missing = await show();
      expect(missing.grid).toBeNull();
      expect(missing.problem).toMatch(/has no beat grid yet/);
      write(BEATS_PATH, JSON.stringify(beatsFile()));
    } finally {
      watcher.close();
    }
  }, 60_000);

  it("a LOW confidence grid is drawn but snapTo refuses it, until an edit vouches for it", async () => {
    write(BEATS_PATH, JSON.stringify(beatsFile({ detector: "onset-flux@1", confidence: 0.3, residualMs: 5, sampleRate: 48_000 })));
    const low = await show();
    expect(low.grid).toMatchObject({ low: true, confidence: 0.3 });
    await expect(request("marker.add", { at: 3.2, label: "low", snapTo: "beat" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("LOW confidence"),
    });
    await expect(request("marker.add", { at: "beat:2", label: "low" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("LOW confidence"),
    });
    write(BEATS_PATH, JSON.stringify(beatsFile({ detector: "onset-flux@1", confidence: 0.3, residualMs: 5, sampleRate: 48_000, edits: { downbeat: 1 } })));
    const added = (await request("marker.add", { at: 3.2, label: "low", snapTo: "beat" })) as { operation: { args: Record<string, unknown> } };
    expect(added.operation.args).toMatchObject({ at: 3 });
    await request("marker.remove", { marker: "low" });
    write(BEATS_PATH, JSON.stringify(beatsFile()));
  });
});

describe("removing the music", () => {
  it("clears the tempo with a warning, and revert brings the clip and the tempo back", async () => {
    const removed = (await request("clip.remove", { clip: music })) as { warnings: string[]; operation: { tx: string } };
    expect(removed.warnings).toEqual([expect.stringMatching(/tempo followed clip .* gone/)]);
    expect(timelineFile()).not.toHaveProperty("tempo");
    await request("revert", { target: removed.operation.tx });
    expect(timelineFile().tempo).toEqual({ clip: music });
    expect(parseTimeline(timelineFile()).ok).toBe(true);
  });

  it("a direct edit that drops the music clip but keeps the tempo is rejected like any invalid edit", async () => {
    const before = timelineFile();
    const dangling = structuredClone(before);
    dangling.tracks[0].clips = [];
    write("timelines/main.json", JSON.stringify(dangling, null, 2));
    await vi.waitFor(async () => expect(((await request("status")) as { rejections: unknown[] }).rejections.length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(timelineFile().tempo).toEqual({ clip: music });
  }, 30_000);
});
