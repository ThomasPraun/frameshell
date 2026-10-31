import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPathOf, trashDetail, trashRefusal } from "../src/main/trash.js";
import { strings } from "../src/shared/i18n/index.js";

const said = strings("en").app.dialogs;

describe("trashRefusal", () => {
  it("keeps the project config, daemon state and the main timeline with what holds it", () => {
    expect(trashRefusal("frameshell.json", "timelines/main.json", said)).toMatch(/holds the project itself/);
    expect(trashRefusal(".FrameShell/cache", "timelines/main.json", said)).toMatch(/holds the project itself/);
    expect(trashRefusal("timelines/main.json", "timelines/main.json", said)).toMatch(/main timeline/);
    expect(trashRefusal("timelines", "timelines/main.json", said)).toMatch(/main timeline/);
    expect(trashRefusal("", "timelines/main.json", said)).toMatch(/inside the project/);
  });

  it("lets everything else go, other timelines too", () => {
    expect(trashRefusal("exports/cut.mp4", "timelines/main.json", said)).toBeNull();
    expect(trashRefusal("timelines/short.json", "timelines/main.json", said)).toBeNull();
    expect(trashRefusal("timelines-old", "timelines/main.json", said)).toBeNull();
  });
});

describe("trashDetail", () => {
  it("names the clips and timelines that lose the file, once per timeline", () => {
    const uses = [
      { timeline: "main", id: "c_a", ref: "assets/a.mp4" },
      { timeline: "main", id: "c_b", ref: "assets/a.mp4" },
      { timeline: "short", id: "c_c", ref: "assets/a.mp4" },
    ];
    expect(trashDetail(uses, "Trash", said)).toBe("3 clips use it (main, short): they show as missing until you put it back. You can put it back from the Trash.");
    expect(trashDetail([], "Recycle Bin", said)).toBe("You can put it back from the Recycle Bin.");
  });
});

describe("projectPathOf", () => {
  it("resolves inside the project and refuses ways out", () => {
    const dir = join("/", "p");
    expect(projectPathOf(dir, "exports/cut.mp4")).toBe(join(dir, "exports", "cut.mp4"));
    expect(() => projectPathOf(dir, "../other")).toThrow(/not inside the project/);
    expect(() => projectPathOf(dir, "")).toThrow(/not inside the project/);
  });
});
