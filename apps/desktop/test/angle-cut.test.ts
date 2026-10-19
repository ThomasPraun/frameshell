import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@frameshell/core";
import { type DaemonConnection, type TimelineView, connectToDaemon } from "@frameshell/protocol";
import { TimelineEditor } from "../src/main/timeline-editor.js";
import { ffmpegRun, testFfmpeg, useTestBinaries } from "../e2e/media.js";
import { createAngleCutter, planAngleCut } from "../src/renderer/src/timeline/angle-cut.js";
import { angleKey } from "../src/renderer/src/timeline/angle-keys.js";
import { type TrackRow, layoutTimeline } from "../src/renderer/src/timeline/layout.js";

// Seam under test: number keys to shots (#242): the plan from the layout and playhead, the keys that count, and
// the cutter's transactions against a real daemon and main's editor.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const GROUP = {
  id: "g_talk",
  angles: ["ana", "ben", "cleo"].map((id) => ({ id, name: id.toUpperCase(), asset: `assets/${id}.mp4`, offset: 0 })),
};

const shot = (id: string, start: number, end: number, layout: string, angles: string[]) => ({
  id,
  type: "shot",
  start,
  end,
  in: start,
  out: end,
  shot: layout,
  angles,
});

function rows(shots: ReturnType<typeof shot>[]): TrackRow[] {
  const view: TimelineView = {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: 10,
    problems: [],
    groups: [GROUP],
    tracks: [{ id: "t_p", kind: "program", name: null, follows: null, group: "g_talk", clips: shots }],
  };
  return layoutTimeline(view).rows;
}

describe("planAngleCut", () => {
  const shots = [shot("c_1", 0, 4, "solo", ["ana"]), shot("c_2", 4, 8, "two-up", ["ana", "ben"])];

  it("splits the shot under the playhead there and sets the new part to solo of the angle in group order", () => {
    expect(planAngleCut(rows(shots), 2, 30, 2, false)).toEqual({ clip: "c_1", splitAt: 2, set: { shot: "solo", angles: ["ben"] }, angle: "BEN" });
    expect(planAngleCut(rows(shots), 2, 30, 3, false)).toMatchObject({ set: { shot: "solo", angles: ["cleo"] } });
  });

  it("sets the shot without splitting when the playhead is on its first frame", () => {
    expect(planAngleCut(rows(shots), 4, 30, 3, false)).toMatchObject({ clip: "c_2", splitAt: null });
  });

  it("puts the split on the frame grid", () => {
    expect(planAngleCut(rows(shots), 1.0123, 30, 2, false)).toMatchObject({ splitAt: 1 });
  });

  it("Shift adds the angle to the shot's own, keeping the layout to the daemon", () => {
    expect(planAngleCut(rows(shots), 1, 30, 2, true)).toMatchObject({ clip: "c_1", set: { angles: ["ana", "ben"] } });
    expect(planAngleCut(rows(shots), 5, 30, 3, true)).toMatchObject({ clip: "c_2", set: { angles: ["ana", "ben", "cleo"] } });
  });

  it("does nothing when the shot already shows exactly that", () => {
    expect(planAngleCut(rows(shots), 1, 30, 1, false)).toEqual({ kind: "unchanged" });
    expect(planAngleCut(rows(shots), 5, 30, 2, true)).toEqual({ kind: "unchanged" });
    // Two-up with the angle among others: solo is a change.
    expect(planAngleCut(rows(shots), 5, 30, 1, false)).toMatchObject({ clip: "c_2" });
  });

  it("refuses a number past the group, a playhead off the shots, and a timeline without a program track", () => {
    expect(planAngleCut(rows(shots), 1, 30, 4, false)).toEqual({ kind: "no-angle", number: 4, count: 3 });
    expect(planAngleCut(rows(shots), 9, 30, 2, false)).toEqual({ kind: "no-shot" });
    expect(planAngleCut(rows(shots), 8, 30, 2, false)).toEqual({ kind: "no-shot" });
    expect(planAngleCut([], 1, 30, 1, false)).toEqual({ kind: "no-program" });
  });
});

describe("angleKey", () => {
  const press = (code: string, extra: Record<string, unknown> = {}) =>
    angleKey({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target: null, ...extra });

  it("takes digits 1-9 of the row and the keypad, Shift adding", () => {
    expect(press("Digit1")).toEqual({ number: 1, additive: false });
    expect(press("Numpad9")).toEqual({ number: 9, additive: false });
    expect(press("Digit2", { shiftKey: true })).toEqual({ number: 2, additive: true });
  });

  it("leaves 0, other keys, shortcuts with a modifier, repeats and typing alone", () => {
    expect(press("Digit0")).toBeNull();
    expect(press("KeyA")).toBeNull();
    expect(press("Digit1", { metaKey: true })).toBeNull();
    expect(press("Digit1", { ctrlKey: true })).toBeNull();
    expect(press("Digit1", { altKey: true })).toBeNull();
    expect(press("Digit1", { repeat: true })).toBeNull();
    expect(press("Digit1", { target: { nodeType: 1, tagName: "INPUT", type: "text", isContentEditable: false } })).toBeNull();
    expect(press("Digit1", { target: { nodeType: 1, tagName: "TEXTAREA", isContentEditable: false } })).toBeNull();
    expect(press("Digit1", { target: { nodeType: 1, tagName: "SELECT", isContentEditable: false } })).toBeNull();
    expect(press("Digit1", { target: { nodeType: 1, tagName: "BUTTON", isContentEditable: false } })).not.toBeNull();
  });
});

describe("the angle cutter against a daemon", () => {
  const FIXTURE = {
    $schema: "https://frameshell.dev/schema/v1/timeline.json",
    schemaVersion: 1,
    id: "main",
    revision: 0,
    groups: [GROUP],
    tracks: [
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [{ id: "c_s", type: "shot", start: 0, in: 0, out: 10, shot: "solo", angles: ["ana"] }],
      },
    ],
  };

  async function setup() {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "fs-angle-")));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\frameshell-angle-${randomUUID().slice(0, 8)}` : join(work, "d.sock");
    const configDir = join(work, "config");
    await useTestBinaries(configDir);
    const daemon = await startDaemon({ socketPath, dirs: { dataDir: join(work, "data"), configDir } });
    cleanups.push(() => daemon.close());
    const connect = async (client: string, session?: string): Promise<DaemonConnection> => {
      const connection = await connectToDaemon(socketPath, { client, ...(session ? { session } : {}) });
      cleanups.push(() => connection.close());
      return connection;
    };
    const app = await connect("desktop/test");
    const dir = join(work, "talk");
    await app.request("project.init", { dir });
    mkdirSync(join(dir, "assets"), { recursive: true });
    const ffmpeg = await testFfmpeg();
    for (const angle of GROUP.angles) {
      await ffmpegRun(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "color=c=gray:s=64x36:r=30:d=10", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=10"],
        ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, angle.asset)],
      ]);
    }
    const loader = await connect("cli/loader", "loader-1");
    await loader.request("file.write", { path: join(dir, "timelines", "main.json"), content: JSON.stringify(FIXTURE) });
    const editor = new TimelineEditor((method, params) => app.request(method, params));
    const host = {
      show: (timeline: string) => app.request("timeline.show", { cwd: dir, timeline }),
      edit: (timeline: string, edits: Parameters<TimelineEditor["apply"]>[2], options?: Parameters<TimelineEditor["apply"]>[3]) =>
        editor.apply(dir, timeline, edits, options),
      settle: () => editor.settle(),
    };
    let state = { time: 0, playing: false };
    const listeners = new Set<() => void>();
    const transport = {
      get: () => state,
      subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    };
    const set = (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    };
    const shots = async () => {
      const view = await app.request("timeline.show", { cwd: dir, timeline: "main" });
      return (view.tracks[0]!.clips as unknown as { start: number; in: number; out: number; shot: string; angles: string[] }[]).map((clip) => [
        clip.start,
        clip.out,
        clip.shot,
        clip.angles.join("+"),
      ]);
    };
    const ui = async () =>
      (await app.request("history", { cwd: dir, timeline: "main" })).transactions.filter((tx) => tx.author === "ui").map((tx) => [tx.label, tx.operations.map((op) => op.op)]);
    return { dir, app, editor, cutter: createAngleCutter(host, transport), set, shots, ui };
  }

  it("a press while paused is one transaction of its own, one undo", async () => {
    const { editor, dir, cutter, set, shots, ui } = await setup();
    set({ time: 2 });
    expect(await cutter.cut(2)).toMatchObject({ kind: "cut" });
    set({ time: 6 });
    await cutter.cut(3);
    expect(await shots()).toEqual([
      [0, 2, "solo", "ana"],
      [2, 6, "solo", "ben"],
      [6, 10, "solo", "cleo"],
    ]);
    expect(await ui()).toEqual([
      ["Cut to BEN", ["clip.split", "shot.set"]],
      ["Cut to CLEO", ["clip.split", "shot.set"]],
    ]);
    await editor.undo(dir, "main");
    expect(await shots()).toEqual([
      [0, 2, "solo", "ana"],
      [2, 10, "solo", "ben"],
    ]);
  });

  it("the presses of one playback are one transaction, closed when it stops", async () => {
    const { editor, dir, cutter, set, shots, ui, app } = await setup();
    set({ time: 1, playing: true });
    await cutter.cut(2);
    set({ time: 3.5 });
    await cutter.cut(1);
    set({ time: 3.5, playing: false });
    // Closed by the stop, not by the next edit: nothing stays open for `ui`.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: expect.anything() });
    expect(await shots()).toEqual([
      [0, 1, "solo", "ana"],
      [1, 3.5, "solo", "ben"],
      [3.5, 10, "solo", "ana"],
    ]);
    expect(await ui()).toEqual([["Cut to angles", ["clip.split", "shot.set", "clip.split", "shot.set"]]]);

    await editor.undo(dir, "main");
    expect(await shots()).toEqual([[0, 10, "solo", "ana"]]);
  });

  it("a second playback is a transaction of its own", async () => {
    const { cutter, set, ui } = await setup();
    set({ time: 1, playing: true });
    await cutter.cut(2);
    set({ playing: false });
    set({ time: 5, playing: true });
    await cutter.cut(3);
    set({ playing: false });
    expect((await ui()).length).toBe(2);
  });

  it("Shift adds the angle: two-up, then a grid", async () => {
    const { cutter, set, shots } = await setup();
    set({ time: 4 });
    await cutter.cut(2, true);
    set({ time: 7 });
    await cutter.cut(3, true);
    expect(await shots()).toEqual([
      [0, 4, "solo", "ana"],
      [4, 7, "two-up", "ana+ben"],
      [7, 10, "grid", "ana+ben+cleo"],
    ]);
  });

  it("a press on the first frame of a shot sets it without splitting, and one that changes nothing sends nothing", async () => {
    const { cutter, set, shots, ui } = await setup();
    expect(await cutter.cut(1)).toEqual({ kind: "unchanged" });
    set({ time: 0 });
    await cutter.cut(2);
    expect(await shots()).toEqual([[0, 10, "solo", "ben"]]);
    expect(await ui()).toEqual([["Cut to BEN", ["shot.set"]]]);
  });
});
