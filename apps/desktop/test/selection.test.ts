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
    expect(selection.get()).toEqual({ clips: ["c_a"], origin: "script", reveal: null });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "timeline", reveal: null });
    selection.toggleClip("c_a", "timeline");
    expect(selection.get().clips).toEqual(["c_b"]);
    selection.clear();
    selection.clear();
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null });
    expect(changes).toBe(5);
    off();
  });

  it("prunes clips a new revision no longer has, keeping order and origin", () => {
    selection.selectClips(["c_a", "c_gone", "c_b"], "script");
    const before = selection.get();
    selection.retainClips(new Set(["c_a", "c_b", "c_gone"]));
    expect(selection.get()).toBe(before);
    selection.retainClips(new Set(["c_b", "c_a"]));
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "script", reveal: null });
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null });
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

  it("selections without reveal carry none, and an empty one never reveals", () => {
    selection.selectClips(["c_a"], "script", { reveal: true });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get().reveal).toBeNull();
    selection.selectClips([], "script", { reveal: true });
    expect(selection.get()).toEqual({ clips: [], origin: null, reveal: null });
  });
});
