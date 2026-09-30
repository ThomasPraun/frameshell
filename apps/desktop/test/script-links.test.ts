import { parseScript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { selection } from "../src/renderer/src/selection.js";
import { isScriptPath, linkScenes } from "../src/shared/script-links.js";

const script = parseScript("# Launch\n## Intro\nHi\n## Demo\nLook\n## Outro\nBye\n");
const clips = [
  { id: "c_a", scriptRef: "scripts/launch.md#intro" },
  { id: "c_b", scriptRef: "./scripts/launch.md#intro" },
  { id: "c_c", scriptRef: "scripts/launch.md#demo" },
  { id: "c_other", scriptRef: "scripts/other.md#outro" },
  { id: "c_gone", scriptRef: "scripts/launch.md#removed" },
  { id: "c_music", scriptRef: "scripts/launch.md" },
  { id: "c_take", scriptRef: "./scripts/launch.md#" },
  { id: "c_elsewhere", scriptRef: "scripts/other.md" },
  { id: "c_none" },
];

describe("linkScenes", () => {
  it("lists each scene's clips, and which scenes hold a selected clip", () => {
    const links = linkScenes("scripts/launch.md", script.scenes, clips, ["c_c", "c_other"]);
    expect(links.scenes.map(({ slug, line, endLine, clips, selected }) => ({ slug, line, endLine, clips, selected }))).toEqual([
      { slug: "intro", line: 2, endLine: 3, clips: ["c_a", "c_b"], selected: false },
      { slug: "demo", line: 4, endLine: 5, clips: ["c_c"], selected: true },
      { slug: "outro", line: 6, endLine: 8, clips: [], selected: false },
    ]);
    expect(links.wholeSelected).toBe(false);
  });

  it("links refs without anchor to the whole script, covering no scene", () => {
    const links = linkScenes("scripts/launch.md", script.scenes, clips, ["c_music"]);
    expect(links.wholeClips).toEqual(["c_music", "c_take"]);
    expect(links.wholeSelected).toBe(true);
    expect(links.scenes.every((scene) => !scene.selected)).toBe(true);
    expect(links.scenes.find((scene) => scene.slug === "outro")!.clips).toEqual([]);
  });
});

describe("isScriptPath", () => {
  it("accepts Markdown under scripts/ only", () => {
    expect(isScriptPath("scripts/launch.md")).toBe(true);
    expect(isScriptPath("scripts/drafts/v2.MD")).toBe(true);
    expect(isScriptPath("README.md")).toBe(false);
    expect(isScriptPath("scripts/notes.txt")).toBe(false);
  });
});

describe("selection store", () => {
  it("replaces, toggles and clears clips with their origin, notifying only on change", () => {
    let changes = 0;
    const off = selection.subscribe(() => changes++);
    selection.selectClips(["c_a"], "timeline");
    const first = selection.get();
    selection.selectClips(["c_a"], "timeline");
    expect(selection.get()).toBe(first);
    selection.selectClips(["c_a"], "script");
    expect(selection.get()).toEqual({ clips: ["c_a"], origin: "script" });
    selection.toggleClip("c_b", "timeline");
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "timeline" });
    selection.toggleClip("c_a", "timeline");
    expect(selection.get().clips).toEqual(["c_b"]);
    selection.clear();
    selection.clear();
    expect(selection.get()).toEqual({ clips: [], origin: null });
    expect(changes).toBe(5);
    off();
  });

  it("prunes clips a new revision no longer has, keeping order and origin", () => {
    selection.selectClips(["c_a", "c_gone", "c_b"], "script");
    const before = selection.get();
    selection.retainClips(new Set(["c_a", "c_b", "c_gone"]));
    expect(selection.get()).toBe(before);
    selection.retainClips(new Set(["c_b", "c_a"]));
    expect(selection.get()).toEqual({ clips: ["c_a", "c_b"], origin: "script" });
    selection.retainClips(new Set());
    expect(selection.get()).toEqual({ clips: [], origin: null });
  });
});

