import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError, TIME_REF_FIELDS, operationArgs } from "@frameshell/protocol";
import { type BeatsFile, type Timeline, createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { TimelineService } from "../src/timeline/service.js";
import { tempoGrid } from "../src/timeline/tempo.js";
import { GridNeeded, TimeRefError, resolveTimeRef, resolveTimeRefs } from "../src/timeline/time-ref.js";
import { tempDir } from "./helpers.js";

// Seam under test: the TimeRef resolver (pure), and the daemon's use of it in front of the engine.

const timeline = {
  id: "main",
  markers: [
    { id: "m_a", at: 1, label: "intro" },
    { id: "m_b", at: 4, label: "Hook" },
    { id: "m_c", at: 9, label: "end-card" },
  ],
};
const scope = { timeline };

function failure(run: () => unknown): TimeRefError {
  try {
    run();
  } catch (error) {
    if (error instanceof TimeRefError) return error;
    throw error;
  }
  throw new Error("expected a TimeRefError");
}

describe("resolveTimeRef", () => {
  it("passes seconds through, as a number or as numeric text", () => {
    expect(resolveTimeRef(2.5, scope)).toBe(2.5);
    expect(resolveTimeRef("2.5", scope)).toBe(2.5);
    expect(resolveTimeRef(" 12 ", scope)).toBe(12);
  });

  it("reads only plain decimals as seconds, and accepts a leading dot in an offset", () => {
    expect(resolveTimeRef(".5", scope)).toBe(0.5);
    expect(resolveTimeRef("hook+.5", scope)).toBe(4.5);
    for (const text of ["0x10", "1e2"]) expect(failure(() => resolveTimeRef(text, scope)).message).toContain("neither seconds nor a marker");
  });

  it("finds a marker by id, or by label ignoring case", () => {
    expect(resolveTimeRef("m_b", scope)).toBe(4);
    expect(resolveTimeRef("hook", scope)).toBe(4);
    expect(resolveTimeRef("HOOK", scope)).toBe(4);
  });

  it("adds an offset after a marker name and keeps the sum tidy", () => {
    expect(resolveTimeRef("hook+0.5", scope)).toBe(4.5);
    expect(resolveTimeRef("hook - 1", scope)).toBe(3);
    expect(resolveTimeRef("m_a+0.1", { timeline: { id: "main", markers: [{ id: "m_a", at: 4.1, label: "x" }] } })).toBe(4.2);
  });

  it("tries the whole text as a name first, so a label holding a minus sign is not an offset", () => {
    expect(resolveTimeRef("end-card", scope)).toBe(9);
    expect(resolveTimeRef("end-card-2", scope)).toBe(7);
    expect(resolveTimeRef("end-card+1", scope)).toBe(10);
  });

  it("refuses an unknown name and lists the markers, or says there are none", () => {
    expect(failure(() => resolveTimeRef("outro", scope)).message).toContain('Markers: m_a "intro" at 1 s, m_b "Hook" at 4 s, m_c "end-card" at 9 s.');
    expect(failure(() => resolveTimeRef("outro", { timeline: { id: "main" } })).message).toContain("It has no markers");
    expect(failure(() => resolveTimeRef("outro+1", scope)).message).toContain('"outro+1" is neither seconds nor a marker');
  });

  it("refuses a time before the start", () => {
    expect(failure(() => resolveTimeRef("intro-2", scope)).message).toContain("before the start of the timeline");
    expect(failure(() => resolveTimeRef(-1, scope)).message).toContain("before the start");
    expect(failure(() => resolveTimeRef("   ", scope)).message).toContain("empty");
  });

  it("keeps word: reserved, and says beat: and bar: need a tempo when the timeline has none", () => {
    expect(failure(() => resolveTimeRef("word:over", scope)).message).toContain("word references");
    expect(failure(() => resolveTimeRef("beat:32", scope)).message).toContain("the timeline has no tempo");
    expect(failure(() => resolveTimeRef("bar:8", scope)).hint).toContain("tempo.set");
  });

  it("asks for the grid of a timeline with a tempo, and fails plainly for a caller that cannot read one", () => {
    const tempoed = { timeline: { ...timeline, tempo: { bpm: 120 } } };
    expect(failure(() => resolveTimeRef("beat:2", tempoed))).toBeInstanceOf(GridNeeded);
    expect(failure(() => resolveTimeRef("bar:2", tempoed)).message).toContain("beat grid");
  });

  it("lets a label that looks like a scheme win over the reserved name", () => {
    const marked = { timeline: { id: "main", markers: [{ id: "m_d", at: 6, label: "beat:drop" }] } };
    expect(resolveTimeRef("beat:drop", marked)).toBe(6);
  });
});

describe("resolveTimeRefs", () => {
  it("turns the listed fields of an operation into seconds and leaves the rest", async () => {
    const request = { op: "clip.trim", args: { clip: "hook", start: "hook", end: "hook+2", in: 1 } } as const;
    const resolved = await resolveTimeRefs(request, timeline);
    expect(resolved).toEqual({ op: "clip.trim", args: { clip: "hook", start: 4, end: 6, in: 1 } });
    expect(request.args.start).toBe("hook");
  });

  it("returns the request itself when nothing needs resolving", async () => {
    const request = { op: "transition.set", args: { at: 4, kind: "dissolve", duration: 0.5 } } as const;
    expect(await resolveTimeRefs(request, timeline)).toBe(request);
    const other = { op: "track.add", args: { kind: "video" } } as const;
    expect(await resolveTimeRefs(other, timeline)).toBe(other);
  });

  it("names the operation and the argument when a reference fails", async () => {
    try {
      await resolveTimeRefs({ op: "cut", args: { from: "intro", to: "nowhere" } }, timeline);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpc = error as RpcError;
      expect(rpc.code).toBe(ErrorCode.InvalidOperation);
      expect(rpc.message).toMatch(/^cut: to: "nowhere" is neither seconds nor a marker of timeline main\. Markers: /);
      expect(rpc.data).toMatchObject({ op: "cut", field: "to", reason: "time reference", value: "nowhere" });
    }
  });
});

// ---------- beat:N and bar:N (ADR 0029 slice 4): the same grid `--snap-to` reads ----------

const FPS = 30;

/** A beats file of a 120 BPM track whose first beat is 0.2 s in: beats 0.2, 0.7, … and a bar every 4 beats. */
function beatsFile(overrides: Partial<BeatsFile> = {}): BeatsFile {
  return {
    schemaVersion: 1,
    asset: "assets/music.wav",
    assetHash: `sha256:${"a".repeat(64)}`,
    detector: "onset-flux@1",
    bpm: 120,
    meter: 4,
    downbeat: 0,
    confidence: 0.95,
    beats: Array.from({ length: 40 }, (_, index) => Math.round((0.2 + index * 0.5) * 1000) / 1000),
    edits: {},
    ...overrides,
  };
}

/** A timeline with the music on an audio track from second 0 (source 0..20), following it unless `tempo` says otherwise. */
function scored(tempo: Timeline["tempo"] = { clip: "c_music" }): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [{ id: "t_a", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 20 }] }],
    ...(tempo ? { tempo } : {}),
  };
}

/** A grid loader over `timeline` that counts its calls; `file` is the only beats file there is. */
function gridOf(timeline: Timeline, file: BeatsFile | null) {
  const calls: number[] = [];
  const load = (horizon: number) => {
    calls.push(horizon);
    return tempoGrid({ fps: FPS, timeline, horizon, beatsOf: async (asset) => (file && asset === file.asset ? file : null) });
  };
  return { load, calls };
}

/** What `clip.split` at `at` resolves to on `timeline`. */
async function splitAt(at: string, timeline: Timeline, file: BeatsFile | null = null) {
  const { load } = gridOf(timeline, file);
  const resolved = await resolveTimeRefs({ op: "clip.split", args: { clip: "c_1", at } }, timeline, load);
  return (resolved.args as { at: number }).at;
}

describe("beat:N and bar:N", () => {
  const nominal: Timeline = { ...createTimeline("main"), tempo: { bpm: 120 } };

  it("counts from 1 on a nominal grid: beat:1 is the first beat, bar:2 the start of the second bar", async () => {
    expect(await splitAt("beat:1", nominal)).toBe(0);
    expect(await splitAt("beat:3", nominal)).toBe(1);
    expect(await splitAt("bar:1", nominal)).toBe(0);
    expect(await splitAt("bar:2", nominal)).toBe(2);
    expect(await splitAt("BAR:2", nominal)).toBe(2);
  });

  it("follows the offset and meter of a nominal grid, however far the number reaches", async () => {
    const waltz: Timeline = { ...createTimeline("main"), tempo: { bpm: 120, offset: 0.5, meter: 3 } };
    expect(await splitAt("bar:2", waltz)).toBe(2);
    expect(await splitAt("bar:100", nominal)).toBe(198);
    expect(await splitAt("beat:5000", nominal)).toBe(2499.5);
  });

  it("adds the optional offset in seconds, like a marker", async () => {
    expect(await splitAt("bar:3-0.2", nominal)).toBe(3.8);
    expect(await splitAt("beat:17 + 0.1", nominal)).toBe(8.1);
  });

  it("interpolates a fractional number between neighbours", async () => {
    expect(await splitAt("beat:2.5", nominal)).toBe(0.75);
    expect(await splitAt("bar:2.5", nominal)).toBe(3);
  });

  it("reads a measured grid through the music clip, with bars from the downbeat", async () => {
    const file = beatsFile();
    expect(await splitAt("beat:1", scored(), file)).toBe(0.2);
    expect(await splitAt("beat:3", scored(), file)).toBe(1.2);
    expect(await splitAt("bar:2", scored(), file)).toBe(2.2);
    const shifted = beatsFile({ downbeat: 1 });
    expect(await splitAt("bar:1", scored(), shifted)).toBe(0.7);
  });

  it("loads the grid once for every argument of an operation, and not at all for seconds and markers", async () => {
    const { load, calls } = gridOf(scored(), beatsFile());
    const cut = await resolveTimeRefs({ op: "cut", args: { from: "bar:1", to: "bar:3" } }, scored(), load);
    expect(cut.args).toMatchObject({ from: 0.2, to: 4.2 });
    expect(calls).toHaveLength(1);
    await resolveTimeRefs({ op: "cut", args: { from: 1, to: "hook" } }, { ...scored(), markers: [{ id: "m_a", at: 2, label: "hook" }] }, load);
    expect(calls).toHaveLength(1);
  });

  it("refuses with the words of --snap-to: no tempo, no beats file yet, a LOW confidence grid", async () => {
    const none = await splitAt("bar:2", createTimeline("main")).catch((error: unknown) => error);
    expect(none).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining('clip.split: at: "bar:2": the timeline has no tempo.') });
    const unmeasured = await splitAt("beat:2", scored(), null).catch((error: unknown) => error);
    expect(unmeasured).toMatchObject({ message: expect.stringContaining("assets/music.wav has no beat grid yet") });
    const low = await splitAt("beat:2", scored(), beatsFile({ confidence: 0.3 })).catch((error: unknown) => error);
    expect(low).toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("the grid of assets/music.wav is LOW confidence (0.3): it may be double time or a bar off."),
      data: expect.objectContaining({ reason: "time reference", field: "at", value: "beat:2" }),
    });
    const vouched = beatsFile({ confidence: 0.3, edits: { downbeat: 0 } });
    expect(await splitAt("beat:2", scored(), vouched)).toBe(0.7);
  });

  it("reads beat:/bar: as the grid even when an older project stored a marker with that label", async () => {
    const stored: Timeline = { ...nominal, markers: [{ id: "m_s", at: 9, label: "bar:2" }, { id: "m_t", at: 9, label: "beat:3" }] };
    expect(await splitAt("bar:2", stored)).toBe(2);
    expect(await splitAt("BAR:2-0.5", stored)).toBe(1.5);
    expect(await splitAt("m_s", stored)).toBe(9);
  });

  it("carries a measured grid on at its period past the music instead of refusing", async () => {
    expect(await splitAt("beat:40", scored(), beatsFile())).toBe(19.7);
    expect(await splitAt("beat:41", scored(), beatsFile())).toBe(20.2);
    expect(await splitAt("bar:11", scored(), beatsFile())).toBe(20.2);
    expect(await splitAt("beat:40.5", scored(), beatsFile())).toBe(19.95);
    expect(await splitAt("bar:101", scored(), beatsFile())).toBe(200.2);
  });

  describe("counts in the music file, not in the clip", () => {
    const file = beatsFile();
    /** The clip plays source 5..20 from timeline `start`: file beat 11 (5.2 s) is the first one it shows, at `start + 0.2`. */
    const trimmed = (start: number): Timeline => ({
      ...scored(),
      tracks: [{ id: "t_a", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start, in: 5, out: 20 }] }],
    });

    it("trimming the head does not renumber", async () => {
      expect(await splitAt("beat:11", trimmed(0), file)).toBe(0.2);
      expect(await splitAt("beat:12", trimmed(0), file)).toBe(0.7);
      // Bar 4 starts at file beat 13 (6.2 s).
      expect(await splitAt("bar:4", trimmed(0), file)).toBe(1.2);
      expect(await splitAt("beat:11", trimmed(3), file)).toBe(3.2);
    });

    it("a beat the trim cut away is carried back at the period, and refused before the timeline starts", async () => {
      expect(await splitAt("beat:10", trimmed(3), file)).toBe(2.7);
      const error = await splitAt("beat:10", trimmed(0), file).catch((thrown: unknown) => thrown);
      expect((error as RpcError).message).toMatch(/before the start of the timeline/);
    });

    it("bar:N counts from the first downbeat, so with a pickup it is not beat:(meter*(N-1)+1)", async () => {
      const pickup = beatsFile({ downbeat: 1 });
      expect(await splitAt("beat:5", scored(), pickup)).toBe(2.2);
      expect(await splitAt("bar:2", scored(), pickup)).toBe(2.7);
      expect(await splitAt("bar:1", scored(), pickup)).toBe(await splitAt("beat:2", scored(), pickup));
    });
  });

  it("refuses numbers it cannot read, and anything before the first beat", async () => {
    for (const text of ["beat:0", "bar:0.5", "beat:", "beat:two", "bar:-1", "beat:1e2"]) {
      const error = await splitAt(text, nominal).catch((thrown: unknown) => thrown);
      expect(error, text).toBeInstanceOf(RpcError);
      expect((error as RpcError).message, text).toMatch(/not a (beat|bar) number|before the first/);
    }
  });

  it("fails as a plain reference error for a caller with no way to read a grid", async () => {
    await expect(resolveTimeRefs({ op: "clip.split", args: { clip: "c_1", at: "beat:2" } }, nominal)).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("beat grid"),
    });
  });
});

describe("TIME_REF_FIELDS", () => {
  const ops = Object.keys(TIME_REF_FIELDS) as (keyof typeof TIME_REF_FIELDS)[];

  it("lists only arguments whose schema takes a name as well as seconds", () => {
    for (const op of ops) {
      const shape = (operationArgs[op] as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
      for (const field of TIME_REF_FIELDS[op]) {
        expect(shape[field]!.safeParse("hook").success, `${op}.${field} takes a name`).toBe(true);
        expect(shape[field]!.safeParse(2).success, `${op}.${field} takes seconds`).toBe(true);
        expect(shape[field]!.safeParse(-1).success, `${op}.${field} refuses negative seconds`).toBe(false);
      }
    }
  });

  it("leaves source-clock times as plain seconds", () => {
    const trim = (operationArgs["clip.trim"] as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
    expect(trim["in"]!.safeParse("hook").success).toBe(false);
    expect(trim["out"]!.safeParse("hook").success).toBe(false);
  });
});

// ---------- daemon: names resolve in front of the engine ----------

const TX = { id: "tx_00000001", label: null };
const PROBE: MediaProbe = {
  duration: 4,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

function project(): string {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "a.mp4"), "not really media");
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  const main = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] };
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify(main));
  return root;
}

function session(beatsOf?: (root: string, asset: string) => Promise<BeatsFile | null>) {
  const root = project();
  let next = 0;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
    ...(beatsOf ? { beatsOf } : {}),
  });
  const run = (op: string, args: Record<string, unknown>) =>
    timelines.apply({ root, cwd: root, timeline: "main", author: "cli", tx: TX, request: { op, args } as never });
  return { timelines, run, root };
}

describe("time references in operations", () => {
  async function marked() {
    const s = session();
    await s.run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 0 });
    await s.run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 4 });
    await s.run("marker.add", { at: 4, label: "hook" });
    return s;
  }

  it("resolves a marker in transition.set and records the seconds in the journal", async () => {
    const { run } = await marked();
    const result = await run("transition.set", { at: "hook", kind: "dissolve", duration: 0.5 });
    expect(result.operation.args).toMatchObject({ at: 4 });
    expect((await run("transition.remove", { at: "Hook" })).operation.args).toMatchObject({ at: 4 });
  });

  it("resolves an offset in clip.split and clip.key, and a range in cut", async () => {
    const { run } = await marked();
    const split = await run("clip.split", { clip: "c_2", at: "hook+1" });
    expect(split.operation.args).toMatchObject({ at: 5 });
    const key = await run("clip.key", { clip: "c_2", prop: "opacity", time: "hook+0.5", value: 0.5 });
    expect(key.operation.args).toMatchObject({ time: 4.5 });
    const cut = await run("cut", { from: "hook", to: "hook+0.5", snap: false });
    expect(cut.operation.args).toMatchObject({ from: 4, to: 4.5 });
  });

  it("resolves a marker in clip.add start, clip.move start and clip.trim start/end", async () => {
    const { run } = await marked();
    const added = await run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: "hook+4" });
    expect(added.operation.args).toMatchObject({ start: 8 });
    const clip = added.changes.added[0]!;
    const moved = await run("clip.move", { clip, start: "hook+5" });
    expect(moved.operation.args).toMatchObject({ start: 9 });
    const trimmed = await run("clip.trim", { clip, start: "hook+6", end: "hook+8", snap: false });
    expect(trimmed.operation.args).toMatchObject({ start: 10, end: 12 });
  });

  it("sees a marker added earlier, and one a later operation of the same turn moved", async () => {
    const { run } = await marked();
    await run("marker.set", { marker: "hook", at: 6 });
    const split = await run("clip.split", { clip: "c_2", at: "hook" });
    expect(split.operation.args).toMatchObject({ at: 6 });
  });

  it("lets marker.add and marker.set take a marker-relative time", async () => {
    const { run, timelines, root } = await marked();
    await run("marker.add", { at: "hook+1.5", label: "cta" });
    await run("marker.set", { marker: "cta", at: "hook+2" });
    const markers = (await timelines.markers(root, "main")).markers;
    expect(markers.map((marker) => [marker.label, marker.at])).toEqual([
      ["hook", 4],
      ["cta", 6],
    ]);
  });

  it("refuses an unknown name before the engine runs and changes nothing", async () => {
    const { run, timelines, root } = await marked();
    const before = (await timelines.show(root, "main")).revision;
    await expect(run("clip.split", { clip: "c_2", at: "drop" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining('clip.split: at: "drop" is neither seconds nor a marker of timeline main'),
    });
    expect((await timelines.show(root, "main")).revision).toBe(before);
  });
});

describe("beat:N and bar:N in operations", () => {
  async function tempoed() {
    const s = session();
    await s.run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 4 });
    await s.run("tempo.set", { bpm: 120 });
    return s;
  }

  it("resolves a beat or bar of a nominal grid in the operation's turn and records the seconds", async () => {
    const { run } = await tempoed();
    const split = await run("clip.split", { clip: "c_1", at: "bar:4+1" });
    expect(split.operation.args).toMatchObject({ at: 7 });
    const marker = await run("marker.add", { at: "beat:13", label: "verse" });
    expect(marker.operation.args).toMatchObject({ at: 6 });
  });

  it("sees the tempo set earlier, so a later one changes what a name means", async () => {
    const { run, timelines, root } = await tempoed();
    await run("tempo.set", { bpm: 60 });
    const marker = await run("marker.add", { at: "bar:2", label: "verse" });
    expect(marker.operation.args).toMatchObject({ at: 4 });
    expect((await timelines.markers(root, "main")).markers.map((m) => m.at)).toEqual([4]);
  });

  it("refuses without a tempo before the engine runs and changes nothing", async () => {
    const { run, timelines, root } = session();
    await run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 0 });
    const before = (await timelines.show(root, "main")).revision;
    await expect(run("clip.split", { clip: "c_1", at: "bar:2" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining('clip.split: at: "bar:2": the timeline has no tempo.'),
    });
    expect((await timelines.show(root, "main")).revision).toBe(before);
  });

  it("reads the beats file of the followed music clip through the service's beatsOf", async () => {
    const asked: string[] = [];
    const { run, timelines, root } = session(async (_dir, asset) => {
      asked.push(asset);
      return beatsFile({ asset });
    });
    await run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 0 });
    await run("tempo.set", { clip: "c_1" });
    const marker = await run("marker.add", { at: "bar:2-0.2", label: "verse" });
    expect(marker.operation.args).toMatchObject({ at: 2 });
    expect(asked).toContain("assets/a.mp4");
    expect((await timelines.markers(root, "main")).markers.map((m) => m.at)).toEqual([2]);
  });
});
