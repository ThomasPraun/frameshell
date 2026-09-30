import { describe, expect, it } from "vitest";
import { selection } from "../src/renderer/src/selection.js";

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
    expect(selection.get()).toEqual({ clips: ["c_a"], origin: "script", reveal: null, history: null });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "timeline", reveal: null, history: null });
    selection.toggleClip("c_a", "timeline");
    expect(selection.get().clips).toEqual(["c_b"]);
    selection.clear();
    selection.clear();
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null, history: null });
    expect(changes).toBe(5);
    off();
  });

  it("prunes clips a new revision no longer has, keeping order and origin", () => {
    selection.selectClips(["c_a", "c_gone", "c_b"], "script");
    const before = selection.get();
    selection.retainClips(new Set(["c_a", "c_b", "c_gone"]));
    expect(selection.get()).toBe(before);
    selection.retainClips(new Set(["c_b", "c_a"]));
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "script", reveal: null, history: null });
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null, history: null });
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
    expect(first).toEqual({ clips: ["c_a"], origin: "history", reveal: { clip: "c_a", place }, history: "tx_0000000a" });
    // Clicked again: a new reveal request, as for scene headings.
    selection.selectHistory("tx_0000000a", ["c_a"], { clip: "c_a", place });
    expect(selection.get().reveal).not.toBe(first.reveal);
    // A timeline click replaces it: nothing stays highlighted.
    selection.selectClips(["c_b"], "timeline");
    expect(selection.get()).toEqual({ clips: ["c_b"], origin: "timeline", reveal: null, history: null });
  });

  it("pruning keeps a History panel selection whose clips are all gone: removed clips stay highlighted", () => {
    selection.selectHistory("op_0000000b", ["c_a"], null);
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], origin: "history", reveal: null, history: "op_0000000b" });
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
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null, history: null });
  });
});
