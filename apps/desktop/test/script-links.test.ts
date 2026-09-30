import { parseScript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { linkScenes } from "../src/shared/script-links.js";

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
