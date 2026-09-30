import { parseScript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { isScriptPath, linkScenes } from "../src/shared/script-links.js";

const script = parseScript("# Launch\n## Intro\nHi\n## Demo\nLook\n## Outro\nBye\n");
const clips = [
  { id: "c_a", scriptRef: "scripts/launch.md#intro" },
  { id: "c_b", scriptRef: "./scripts/launch.md#intro" },
  { id: "c_c", scriptRef: "scripts/launch.md#demo" },
  { id: "c_other", scriptRef: "scripts/other.md#outro" },
  { id: "c_gone", scriptRef: "scripts/launch.md#removed" },
  { id: "c_none" },
];

describe("linkScenes", () => {
  it("lists each scene's clips, and which scenes hold a selected clip", () => {
    const links = linkScenes("scripts/launch.md", script.scenes, clips, ["c_c", "c_other"]);
    expect(links.map(({ slug, line, endLine, clips, selected }) => ({ slug, line, endLine, clips, selected }))).toEqual([
      { slug: "intro", line: 2, endLine: 3, clips: ["c_a", "c_b"], selected: false },
      { slug: "demo", line: 4, endLine: 5, clips: ["c_c"], selected: true },
      { slug: "outro", line: 6, endLine: 8, clips: [], selected: false },
    ]);
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
