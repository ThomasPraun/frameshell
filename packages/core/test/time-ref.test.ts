import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError, TIME_REF_FIELDS, operationArgs } from "@frameshell/protocol";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { TimelineService } from "../src/timeline/service.js";
import { TimeRefError, resolveTimeRef, resolveTimeRefs } from "../src/timeline/time-ref.js";
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

  it("reserves beat:, bar: and word: for the slices that build them", () => {
    expect(failure(() => resolveTimeRef("beat:32", scope)).message).toContain("beat grid");
    expect(failure(() => resolveTimeRef("bar:8", scope)).message).toContain("does not exist yet");
    expect(failure(() => resolveTimeRef("word:over", scope)).message).toContain("word references");
  });

  it("lets a label that looks like a scheme win over the reserved name", () => {
    const marked = { timeline: { id: "main", markers: [{ id: "m_d", at: 6, label: "beat:drop" }] } };
    expect(resolveTimeRef("beat:drop", marked)).toBe(6);
  });
});

describe("resolveTimeRefs", () => {
  it("turns the listed fields of an operation into seconds and leaves the rest", () => {
    const request = { op: "clip.trim", args: { clip: "hook", start: "hook", end: "hook+2", in: 1 } } as const;
    const resolved = resolveTimeRefs(request, timeline);
    expect(resolved).toEqual({ op: "clip.trim", args: { clip: "hook", start: 4, end: 6, in: 1 } });
    expect(request.args.start).toBe("hook");
  });

  it("returns the request itself when nothing needs resolving", () => {
    const request = { op: "transition.set", args: { at: 4, kind: "dissolve", duration: 0.5 } } as const;
    expect(resolveTimeRefs(request, timeline)).toBe(request);
    const other = { op: "track.add", args: { kind: "video" } } as const;
    expect(resolveTimeRefs(other, timeline)).toBe(other);
  });

  it("names the operation and the argument when a reference fails", () => {
    try {
      resolveTimeRefs({ op: "cut", args: { from: "intro", to: "nowhere" } }, timeline);
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

function session() {
  const root = project();
  let next = 0;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
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
