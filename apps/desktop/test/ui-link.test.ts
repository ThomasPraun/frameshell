import { afterEach, describe, expect, it, vi } from "vitest";
// The renderer modules under test name `window.frameshell` (never called here): its declaration.
import type {} from "../src/renderer/src/env.js";
import type { TimelineView, UiView } from "@frameshell/protocol";
import { createTransport } from "../src/renderer/src/preview/transport.js";
import { selection } from "../src/renderer/src/selection.js";
import { type CommandTargets, type UiHost, createPublisher, runUiCommand, uiView } from "../src/renderer/src/ui-link.js";

// Seams under test: the renderer end of SPEC §7b. `uiView` (what a window reports), `createPublisher` (how often),
// and `runUiCommand` (a navigation command applied to the shared playhead, selection and workspace).

afterEach(() => {
  selection.clear();
  vi.useRealTimers();
});

function timeline(clips: string[], revision = 3): TimelineView {
  return {
    timeline: "main",
    revision,
    fps: 30,
    duration: 10,
    tracks: [{ id: "t_v1", kind: "video", clips: clips.map((id) => ({ id, type: "media", start: 0, end: 1 })) }],
    problems: [],
  } as unknown as TimelineView;
}

const TRANSCRIPT = {
  schemaVersion: 1,
  asset: "assets/raw.mp4",
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  language: "en",
  nextWordId: 5,
  words: [{ id: "w_000004", text: "hello", start: 0.2, end: 0.6, confidence: 0.9 }],
  edits: { w_000004: { text: "Hello" } },
};

/** Targets over a fresh transport with a 10 s program at 30 fps, recording what the workspace was asked. */
function targets(overrides: Partial<CommandTargets> = {}) {
  const transport = createTransport();
  transport.setProgram(300, 30);
  const asked: string[] = [];
  const host: UiHost = {
    editor: () => ({ active: null, tabs: [] }),
    openFile: (path) => void asked.push(`open ${path}`),
    showHistory: () => void asked.push("history"),
  };
  const all: CommandTargets = {
    transport,
    host,
    timelineView: () => timeline(["c_a", "c_b"]),
    readFile: async (path) => {
      if (path !== "transcripts/raw.words.json") throw new Error("ENOENT");
      return JSON.stringify(TRANSCRIPT);
    },
    selectHistory: async (_timeline, target) => void asked.push(`select ${target}`),
    ...overrides,
  };
  return { ...all, asked };
}

describe("uiView", () => {
  it("reports the shared playhead, selection, tabs and visible span, times in milliseconds", () => {
    const transport = createTransport();
    transport.setProgram(301, 30);
    transport.seek(1.1);
    selection.select({ clips: ["c_a"], range: { from: 1 / 3, to: 2 } }, "agent");
    expect(
      uiView({
        transport: transport.get(),
        selection: selection.get(),
        editor: { active: "scripts/a.md", tabs: ["scripts/a.md"] },
        visible: { from: 0, to: 12.34567 },
      }),
    ).toEqual({
      timeline: "main",
      playhead: 1.1,
      playing: false,
      duration: 10.033,
      selection: { clips: ["c_a"], words: [], range: { from: 0.333, to: 2 }, history: null },
      editor: { active: "scripts/a.md", tabs: ["scripts/a.md"] },
      visible: { from: 0, to: 12.346 },
    } satisfies UiView);
  });
});

describe("createPublisher", () => {
  it("sends the first change on the next tick, then at most every interval with the newest view, never a repeat", () => {
    vi.useFakeTimers();
    let playhead = 0;
    const sent: number[] = [];
    const publisher = createPublisher({
      read: () => ({ playhead }) as unknown as UiView,
      send: (view) => void sent.push(view.playhead),
      intervalMs: 100,
      now: () => Date.now(),
    });
    publisher.changed();
    playhead = 1;
    publisher.changed();
    vi.advanceTimersByTime(0);
    expect(sent).toEqual([1]);

    for (const next of [2, 3, 4, 5]) {
      playhead = next;
      publisher.changed();
      vi.advanceTimersByTime(10);
    }
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 5]);

    publisher.changed();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([1, 5]);
    publisher.dispose();
  });
});

describe("runUiCommand", () => {
  it("seeks the shared playhead to a frame, clamped to the program", async () => {
    const t = targets();
    await expect(runUiCommand({ kind: "seek", at: 2.51 }, t)).resolves.toBe("Agent moved the playhead to 00:00:02:15");
    expect(t.transport.get().time).toBe(2.5);
    await runUiCommand({ kind: "seek", at: 99 }, t);
    expect(t.transport.get().time).toBe(10);
  });

  it("plays and pauses, refusing to play an empty timeline", async () => {
    const t = targets();
    await runUiCommand({ kind: "play" }, t);
    expect(t.transport.get().playing).toBe(true);
    await runUiCommand({ kind: "pause" }, t);
    expect(t.transport.get().playing).toBe(false);
    const empty = targets();
    empty.transport.setProgram(0, 30);
    await expect(runUiCommand({ kind: "play" }, empty)).rejects.toThrow(/empty/);
  });

  it("selects clips, words and a range as the agent, revealing the first clip", async () => {
    const words = [{ transcript: "transcripts/raw.words.json", word: "w_000004" }];
    await expect(
      runUiCommand({ kind: "select", clips: ["c_b"], words, range: { from: 1, to: 2 }, reveal: true }, targets()),
    ).resolves.toBe("Agent selected 1 clip, 1 word and a time range");
    expect(selection.get()).toMatchObject({
      clips: ["c_b"],
      // Resolved from the transcript file: asset, edited text and source span, as the transcript view selects words.
      words: [{ transcript: "transcripts/raw.words.json", asset: "assets/raw.mp4", word: "w_000004", text: "Hello", start: 0.2, end: 0.6 }],
      range: { from: 1, to: 2 },
      origin: "agent",
      reveal: { clip: "c_b" },
    });
    await expect(
      runUiCommand({ kind: "select", clips: [], words: [{ transcript: "transcripts/raw.words.json", word: "w_000009" }], range: null, reveal: true }, targets()),
    ).rejects.toThrow("No word w_000009 in transcripts/raw.words.json");
  });

  it("refuses clip ids the timeline does not have, naming them, and keeps the selection", async () => {
    selection.selectClips(["c_a"], "timeline");
    await expect(
      runUiCommand({ kind: "select", clips: ["c_a", "c_zz"], words: [], range: null, reveal: true }, targets()),
    ).rejects.toThrow(/No clip c_zz on timeline main \(revision 3\)/);
    expect(selection.get().clips).toEqual(["c_a"]);
  });

  it("opens a file the app can read in a tab, and names the reason when it cannot", async () => {
    const t = targets({ readFile: async () => "# A" });
    await expect(runUiCommand({ kind: "openFile", path: "scripts/a.md" }, t)).resolves.toBe("Agent opened scripts/a.md");
    const missing = targets({ readFile: () => Promise.reject(new Error("ENOENT: no such file")) });
    await expect(runUiCommand({ kind: "openFile", path: "scripts/b.md" }, missing)).rejects.toThrow("Cannot open scripts/b.md: ENOENT");
    expect([...t.asked, ...missing.asked]).toEqual(["open scripts/a.md"]);
  });

  it("shows a transaction's changes in the History panel, for the main timeline only", async () => {
    const t = targets();
    await runUiCommand({ kind: "showTxDiff", timeline: "main", target: "tx_0000000a" }, t);
    expect(t.asked).toEqual(["select tx_0000000a", "history"]);
    await expect(runUiCommand({ kind: "showTxDiff", timeline: "intro", target: "tx_0000000a" }, t)).rejects.toThrow(/timeline main only/);
    const unknown = targets({ selectHistory: () => Promise.reject(new Error("HistoryNotFound")) });
    await expect(runUiCommand({ kind: "showTxDiff", timeline: "main", target: "tx_0000000b" }, unknown)).rejects.toThrow("HistoryNotFound");
    expect(unknown.asked).toEqual([]);
  });
});
