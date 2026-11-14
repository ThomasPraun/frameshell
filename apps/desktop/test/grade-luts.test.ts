import { describe, expect, it } from "vitest";
import type { FileNode } from "../src/shared/api.js";
import { cubeFiles } from "../src/renderer/src/grade/luts.js";

// Seam under test: which project files the inspector's Colour section offers as LUTs.

const file = (path: string): FileNode => ({ kind: "file", name: path.slice(path.lastIndexOf("/") + 1), path });

describe("cubeFiles", () => {
  it("lists .cube files of every folder, any letter case, sorted; other files are not LUTs", () => {
    const tree: FileNode[] = [
      file("notes.txt"),
      {
        kind: "dir",
        name: "luts",
        path: "luts",
        children: [
          file("luts/warm.cube"),
          file("luts/Cold.CUBE"),
          file("luts/readme.md"),
          { kind: "dir", name: "old", path: "luts/old", children: [file("luts/old/a.cube")] },
        ],
      },
      { kind: "dir", name: "assets", path: "assets", children: [file("assets/a.mp4")] },
    ];
    expect(cubeFiles(tree)).toEqual(["luts/Cold.CUBE", "luts/old/a.cube", "luts/warm.cube"]);
    expect(cubeFiles([])).toEqual([]);
  });
});
