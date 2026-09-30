import { describe, expect, it } from "vitest";
import { type SelectedWord, revealSeek, selection } from "../src/renderer/src/selection.js";

// Seam under test: the renderer's one selection store, as panels call it.

describe("selection store", () => {
  it("replaces, toggles and clears clips with their origin, notifying only on change", () => {
    let changes = 0;
    const off = selection.subscribe(() => changes++);
    selection.selectClips(["c_a"], "timeline");
    const first = selection.get();
    selection.selectClips(["c_a"], "timeline");
    expect(selection.get()).toBe(first);
    selection.selectClips(["c_a"], "script");
    expect(selection.get()).toEqual({ clips: ["c_a"], words: [], range: null, origin: "script", reveal: null, history: null, files: [], scene: null, region: null, track: null });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], words: [], range: null, origin: "timeline", reveal: null, history: null, files: [], scene: null, region: null, track: null });
    selection.toggleClip("c_a", "timeline");
    expect(selection.get().clips).toEqual(["c_b"]);
    selection.clear();
    selection.clear();
    expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
    expect(changes).toBe(5);
    off();
  });

  it("prunes clips a new revision no longer has, keeping order and origin", () => {
    selection.selectClips(["c_a", "c_gone", "c_b"], "script");
    const before = selection.get();
    selection.retainClips(new Set(["c_a", "c_b", "c_gone"]));
    expect(selection.get()).toBe(before);
    selection.retainClips(new Set(["c_b", "c_a"]));
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], words: [], range: null, origin: "script", reveal: null, history: null, files: [], scene: null, region: null, track: null });
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
  });

  it("issues a new reveal request each time, even for the same clips (a scene heading clicked again)", () => {
    let changes = 0;
    const off = selection.subscribe(() => changes++);
    selection.selectClips(["c_a", "c_b"], "script", { reveal: true });
    const first = selection.get().reveal;
    expect(first).toEqual({ clip: "c_a" });
    selection.selectClips(["c_a", "c_b"], "script", { reveal: true });
    const second = selection.get().reveal;
    expect(second).toEqual({ clip: "c_a" });
    expect(second).not.toBe(first);
    expect(changes).toBe(2);
    off();
  });

  it("pruning keeps the pending reveal request as it was: it never asks for a new scroll", () => {
    selection.selectClips(["c_a", "c_b"], "script", { reveal: true });
    const request = selection.get().reveal;
    selection.retainClips(new Set(["c_b"]));
    expect(selection.get().clips).toEqual(["c_b"]);
    expect(selection.get().reveal).toBe(request);
  });

  it("a History panel selection names the transaction and the clips it left, and reveals where it acted", () => {
    const place = { track: "v1", start: 4, end: 6 };
    selection.selectHistory("tx_0000000a", ["c_a"], { clip: "c_a", place });
    const first = selection.get();
    expect(first).toEqual({ clips: ["c_a"], words: [], range: null, origin: "history", reveal: { clip: "c_a", place }, history: "tx_0000000a", files: [], scene: null, region: null, track: null });
    // Clicked again: a new reveal request, as for scene headings.
    selection.selectHistory("tx_0000000a", ["c_a"], { clip: "c_a", place });
    expect(selection.get().reveal).not.toBe(first.reveal);
    // A timeline click replaces it: nothing stays highlighted.
    selection.selectClips(["c_b"], "timeline");
    expect(selection.get()).toEqual({ clips: ["c_b"], words: [], range: null, origin: "timeline", reveal: null, history: null, files: [], scene: null, region: null, track: null });
  });

  it("pruning keeps a History panel selection whose clips are all gone: removed clips stay highlighted", () => {
    selection.selectHistory("op_0000000b", ["c_a"], null);
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: "history", reveal: null, history: "op_0000000b", files: [], scene: null, region: null, track: null });
    selection.selectHistory("op_0000000c", [], null);
    expect(selection.get().history).toBe("op_0000000c");
    selection.clear();
    expect(selection.get().history).toBeNull();
  });

  it("selections without reveal carry none, and an empty one never reveals", () => {
    selection.selectClips(["c_a"], "script", { reveal: true });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get().reveal).toBeNull();
    selection.selectClips([], "script", { reveal: true });
    expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
  });

  describe("words", () => {
    const word = (id: string, start: number): SelectedWord => ({
      transcript: "transcripts/take.words.json",
      asset: "assets/take.mp4",
      word: id,
      text: id,
      start,
      end: start + 0.4,
    });
    const words = [word("w_000001", 1), word("w_000002", 2)];

    it("selecting words replaces clips with words and their timeline range, revealing the range on request", () => {
      selection.selectClips(["c_a"], "timeline");
      selection.selectWords(words, { from: 10, to: 11.4 }, "transcript", { reveal: true });
      expect(selection.get()).toEqual({ clips: [], words, range: { from: 10, to: 11.4 }, origin: "transcript", reveal: { range: { from: 10, to: 11.4 } }, history: null, files: [], scene: null, region: null, track: null });
      const same = selection.get();
      selection.selectWords([...words], { from: 10, to: 11.4 }, "transcript", { reveal: true });
      expect(selection.get().reveal).not.toBe(same.reveal);
      selection.selectClips(["c_b"], "timeline");
      expect(selection.get()).toMatchObject({ clips: ["c_b"], words: [], range: null });
      selection.selectWords([], { from: 0, to: 1 }, "transcript");
      expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
    });

    it("re-places words on a new revision: cut ones drop, the range follows, the reveal request stays", () => {
      selection.selectWords(words, { from: 10, to: 11.4 }, "transcript", { reveal: true });
      const request = selection.get().reveal;
      const before = selection.get();
      selection.retainWords((w) => (w.word === "w_000001" ? { from: 10, to: 10.4 } : { from: 11, to: 11.4 }));
      expect(selection.get()).toBe(before);
      // A ripple before them moved both 2 s later.
      selection.retainWords((w) => (w.word === "w_000001" ? { from: 12, to: 12.4 } : { from: 13, to: 13.4 }));
      expect(selection.get()).toMatchObject({ words, range: { from: 12, to: 13.4 } });
      expect(selection.get().reveal).toBe(request);
      selection.retainWords((w) => (w.word === "w_000001" ? null : { from: 13, to: 13.4 }));
      expect(selection.get()).toMatchObject({ words: [words[1]], range: { from: 13, to: 13.4 }, origin: "transcript" });
      selection.retainWords(() => null);
      expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
    });

    it("words picked on a subtitle track name the track; a track alone can be selected too", () => {
      selection.selectWords(words, { from: 10, to: 11.4 }, "timeline", { reveal: true, track: "s1" });
      expect(selection.get()).toMatchObject({ words, track: "s1", origin: "timeline", reveal: { range: { from: 10, to: 11.4 } } });
      // Same words from the transcript view: no track any more.
      selection.selectWords(words, { from: 10, to: 11.4 }, "transcript");
      expect(selection.get().track).toBeNull();
      selection.selectTrack("s1", "timeline");
      expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: "timeline", reveal: null, history: null, files: [], scene: null, region: null, track: "s1" });
      const same = selection.get();
      selection.selectTrack("s1", "timeline");
      expect(selection.get()).toBe(same);
      selection.selectClips(["c_a"], "timeline");
      expect(selection.get().track).toBeNull();
    });

    it("drops a selected track a new revision removed, with the words picked on it", () => {
      selection.selectTrack("s1", "timeline");
      const before = selection.get();
      selection.retainTrack(new Set(["s1", "v1"]));
      expect(selection.get()).toBe(before);
      selection.retainTrack(new Set(["v1"]));
      expect(selection.get()).toEqual({ clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null });
      selection.selectWords(words, { from: 10, to: 11.4 }, "timeline", { track: "s1" });
      selection.retainTrack(new Set(["v1"]));
      expect(selection.get()).toMatchObject({ words: [], track: null });
    });
  });
  describe("ask-agent kinds (#49)", () => {
    const blank = { clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null };

    it("a timeline range selects time alone; an empty range selects nothing", () => {
      selection.selectClips(["c_a"], "timeline");
      selection.selectRange({ from: 2, to: 4.5 }, "timeline");
      expect(selection.get()).toEqual({ ...blank, range: { from: 2, to: 4.5 }, origin: "timeline" });
      // Clearing clips must not keep the range: a click on an empty lane selects nothing.
      selection.selectClips([], "timeline");
      expect(selection.get()).toEqual(blank);
      selection.selectRange({ from: 3, to: 3 }, "timeline");
      expect(selection.get()).toEqual(blank);
    });

    it("a range survives revisions: words are re-placed, a bare range is time and stays", () => {
      selection.selectRange({ from: 2, to: 4.5 }, "timeline");
      const before = selection.get();
      selection.retainClips(new Set());
      selection.retainWords(() => null);
      expect(selection.get()).toBe(before);
    });

    it("explorer files replace the selection, toggle, and drop when deleted", () => {
      selection.selectClips(["c_a"], "timeline");
      selection.selectFiles(["assets/logo.png"], "explorer");
      expect(selection.get()).toEqual({ ...blank, files: ["assets/logo.png"], origin: "explorer" });
      selection.toggleFile("assets/b.mp4", "explorer");
      expect(selection.get().files).toEqual(["assets/logo.png", "assets/b.mp4"]);
      selection.toggleFile("assets/logo.png", "explorer");
      expect(selection.get().files).toEqual(["assets/b.mp4"]);
      const before = selection.get();
      selection.retainFiles(new Set(["assets/b.mp4", "scripts/a.md"]));
      expect(selection.get()).toBe(before);
      selection.retainFiles(new Set(["scripts/a.md"]));
      expect(selection.get()).toEqual(blank);
    });

    it("a script scene selects its clips and names the scene, which pruning keeps", () => {
      const scene = { script: "scripts/script.md", slug: "intro", title: "Intro" };
      selection.selectScene(scene, ["c_a", "c_b"], { reveal: true });
      expect(selection.get()).toEqual({ ...blank, clips: ["c_a", "c_b"], scene, origin: "script", reveal: { clip: "c_a" } });
      selection.retainClips(new Set(["c_b"]));
      expect(selection.get()).toMatchObject({ clips: ["c_b"], scene });
      selection.retainClips(new Set());
      expect(selection.get()).toMatchObject({ clips: [], scene });
      // A scene with no clips yet is still something to ask about.
      selection.selectScene({ ...scene, slug: "outro", title: "Outro" }, [], { reveal: true });
      expect(selection.get()).toEqual({ ...blank, scene: { ...scene, slug: "outro", title: "Outro" }, origin: "script" });
      selection.selectClips(["c_a"], "timeline");
      expect(selection.get().scene).toBeNull();
    });

    it("a preview region keeps its normalized corners and timeline time until replaced", () => {
      const region = { x0: 0.62, y0: 0.08, x1: 0.94, y1: 0.22, at: 65.2 };
      selection.selectRegion(region, "preview");
      expect(selection.get()).toEqual({ ...blank, region, origin: "preview" });
      const before = selection.get();
      selection.retainClips(new Set());
      selection.retainFiles(new Set());
      expect(selection.get()).toBe(before);
      selection.clear();
      expect(selection.get()).toEqual(blank);
    });
  });

  it("an agent selection replaces every kind at once and reveals its first clip, else its range", () => {
    const word = { transcript: "transcripts/raw.words.json", asset: "assets/raw.mp4", word: "w_000001", text: "hi", start: 1, end: 1.4 };
    selection.select({ clips: ["c_a"], words: [word], range: { from: 1, to: 2 } }, "agent", { reveal: true });
    expect(selection.get()).toMatchObject({
      clips: ["c_a"],
      words: [word],
      range: { from: 1, to: 2 },
      origin: "agent",
      reveal: { clip: "c_a" },
      history: null,
    });
    selection.select({ range: { from: 3, to: 4 } }, "agent", { reveal: true });
    expect(selection.get()).toMatchObject({ clips: [], words: [], range: { from: 3, to: 4 }, origin: "agent", reveal: { range: { from: 3, to: 4 } }, history: null });
    selection.select({}, "agent");
    expect(selection.get()).toMatchObject({ clips: [], words: [], range: null, origin: null, reveal: null, history: null });
  });

  it("tags a History selection made by the agent with its origin", () => {
    selection.selectHistory("tx_0000000d", [], null, "agent");
    expect(selection.get()).toMatchObject({ origin: "agent", history: "tx_0000000d" });
    selection.clear();
  });
});

describe("revealSeek", () => {
  const paused = { playing: false, fps: 30 };
  const playing = { playing: true, fps: 30 };

  it("moves the playhead to the first frame inside revealed words, even while playing", () => {
    expect(revealSeek({ range: { from: 1.2, to: 1.7 } }, null, paused)).toBe(1.2);
    expect(revealSeek({ range: { from: 1.2, to: 1.7 } }, null, playing)).toBe(1.2);
    // 1.21 s lies inside frame 36 (1.2 s): the next frame is the first inside the words.
    expect(revealSeek({ range: { from: 1.21, to: 1.7 } }, null, playing)).toBeCloseTo(37 / 30, 9);
  });

  it("moves the playhead to a revealed clip's start only while paused", () => {
    expect(revealSeek({ clip: "c_a" }, { start: 4 }, paused)).toBe(4);
    expect(revealSeek({ clip: "c_a" }, { start: 4 }, playing)).toBeNull();
    expect(revealSeek({ clip: "c_gone" }, null, paused)).toBeNull();
  });
});
