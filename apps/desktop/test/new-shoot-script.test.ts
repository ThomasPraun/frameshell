import { parseShootScript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { newShootScript } from "../src/renderer/src/teleprompter/model.js";

describe("newShootScript", () => {
  it("makes a shoot script of plain text, one scene, never over a script that is there", () => {
    const { path, content } = newShootScript("Hello there.\r\n\r\nSecond line.\n", "Script", ["scripts/shoot.md", "scripts/outline.md"]);
    expect(path).toBe("scripts/shoot-2.md");
    const script = parseShootScript(content);
    expect(script.shoot.shoot).toBe(true);
    expect(script.meta.title).toBe("Script");
    expect(script.scenes.map((scene) => scene.lines.map((line) => line.text))).toEqual([["Hello there.", "Second line."]]);
    expect(script.warnings).toEqual([]);
  });

  it("keeps the scenes the text names", () => {
    const { path, content } = newShootScript("## Hook\nHi.\n## End\nBye.", "Guion", []);
    expect(path).toBe("scripts/shoot.md");
    expect(parseShootScript(content).scenes.map((scene) => scene.title)).toEqual(["Hook", "End"]);
  });
});
