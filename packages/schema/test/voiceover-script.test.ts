import { describe, expect, it } from "vitest";
import { parseScript, parseShootScript, parseVoiceoverScript, spellNumbersIn } from "../src/index.js";

const SCRIPT = [
  "---",
  "title: Launch",
  "voiceover: true",
  "language: es",
  "provider: kokoro",
  "voice: ef_dora",
  "---",
  "## Hook (0:00–0:09)",
  "¿Cuántas pestañas tenés abiertas? Son 23.",
  "[VISUAL: browser with 23 tabs]",
  "",
  "## The fix",
  "{Frameshell|freim shel} las cierra por vos, en 1,5 segundos.",
  "Probalo con **mp4** y v1.2.",
].join("\n");

describe("parseVoiceoverScript", () => {
  it("gives each spoken line an id, a display form and a spoken form", () => {
    const script = parseVoiceoverScript(SCRIPT);
    expect(script.voiceover).toEqual({ voiceover: true, language: "es", provider: "kokoro", voice: "ef_dora" });
    expect(script.warnings).toEqual([]);
    expect(script.scenes.map((scene) => [scene.slug, scene.expected, scene.words])).toEqual([
      ["hook", 9, 6],
      ["the-fix", null, 17],
    ]);
    const [hook, fix1, fix2] = script.scenes.flatMap((scene) => scene.lines);
    expect(hook).toMatchObject({ id: "hook-1", scene: "hook", line: 9, display: "¿Cuántas pestañas tenés abiertas? Son 23.", spoken: "¿Cuántas pestañas tenés abiertas? Son veintitrés." });
    expect(fix1).toMatchObject({
      id: "the-fix-1",
      line: 13,
      display: "Frameshell las cierra por vos, en 1,5 segundos.",
      spoken: "freim shel las cierra por vos, en uno coma cinco segundos.",
    });
    expect(fix2).toMatchObject({ id: "the-fix-2", display: "Probalo con mp4 y v1.2.", spoken: "Probalo con mp4 y v1.2." });
  });

  it("skips lines of cues only, so adding one keeps the ids of the others", () => {
    const script = parseVoiceoverScript(["---", "voiceover: true", "---", "## A", "[MUSIC: in]", "One line.", "[PAUSE]", "Two line."].join("\n"));
    expect(script.scenes[0]!.lines.map((line) => [line.id, line.line])).toEqual([
      ["a-1", 6],
      ["a-2", 8],
    ]);
  });

  it("warns about digits without a number language, a scene over its timing and FREE cues", () => {
    const long = Array(30).fill("palabra").join(" ");
    const script = parseVoiceoverScript(["---", "voiceover: true", "---", "## Intro (0:00–0:09)", long, "Son 23. [FREE: anything]"].join("\n"));
    expect(script.scenes[0]!.lines[1]!.spoken).toBe("Son 23.");
    expect(script.warnings).toEqual([
      "Line 6: `[FREE: …]` means nothing in a voiceover (the voice improvises nothing): ignored.",
      'Scene "intro": 32 words take about 12.8 s at 2.5 words/s, longer than its 9 s. Trim the text; never stretch the picture.',
      "Line 6 has digits the voice reads its own way: set `language: es` or `language: en` to spell them out, or write them in words.",
    ]);
  });

  it("reads a script without `voiceover: true`, with a warning", () => {
    const script = parseVoiceoverScript("## Intro\nHola.");
    expect(script.voiceover.voiceover).toBe(false);
    expect(script.scenes[0]!.lines.map((line) => line.id)).toEqual(["intro-1"]);
    expect(script.warnings).toEqual(["Not a voiceover script: add `voiceover: true` to the frontmatter."]);
  });

  it("leaves heading timings out of the anchor, as shoot scripts do", () => {
    expect(parseScript(SCRIPT).scenes.map((scene) => scene.slug)).toEqual(["hook", "the-fix"]);
    expect(parseScript(SCRIPT.replace("voiceover: true", "other: 1")).scenes[0]!.slug).toBe("hook-000009");
  });

  it("leaves shoot scripts as they were", () => {
    const shoot = parseShootScript(["---", "shoot: true", "---", "Before.", "## Hook (0:00–0:05)", "**Ana:** Hola."].join("\n"));
    expect(shoot.warnings).toEqual(["Line 4: text before the first `## ` heading is in no scene and is not compared."]);
    expect(shoot.scenes[0]).toMatchObject({ slug: "hook", expected: 5, words: 1 });
  });
});

describe("spellNumbersIn", () => {
  it("spells standalone numbers and keeps punctuation and digits glued to letters", () => {
    expect(spellNumbersIn("Son 23, y 1.500 más.", "es")).toBe("Son veintitrés, y mil quinientos más.");
    expect(spellNumbersIn("Page 21 of mp3s, v2.", "en")).toBe("Page twenty one of mp3s, v2.");
  });
});
