import { describe, expect, it } from "vitest";
import { isScriptPath, parseScript, parseShootScript, scriptRefPathProblem, scriptSlug, splitScriptRef } from "../src/index.js";

describe("scene words comment (ADR 0015)", () => {
  const scene = (text: string) => parseScript(text).scenes[0]!;

  it("reads a range from the comment under the heading and leaves it out of the word count", () => {
    const found = scene("## Intro\n<!-- words: w_000010..w_000042 -->\nHola a todos.");
    expect(found.wordRange).toEqual({ transcript: null, from: "w_000010", to: "w_000042" });
    expect(found.words).toBe(3);
    expect(found.endLine).toBe(3);
  });

  it("takes a single id as a one-word range, tolerates spacing, case and blank lines before the comment", () => {
    expect(scene("## A\n\n<!--words : w_000007-->\n").wordRange).toEqual({ transcript: null, from: "w_000007", to: "w_000007" });
    expect(scene("## A\n<!--  WORDS: w_000001 .. w_000002  -->").wordRange).toEqual({ transcript: null, from: "w_000001", to: "w_000002" });
    expect(scene("## A\n<!-- words: talk.words.json w_000001..w_000002 -->").wordRange).toEqual({ transcript: "talk.words.json", from: "w_000001", to: "w_000002" });
  });

  it("is optional: scenes without it behave as before and stay warning-free", () => {
    const outline = parseScript("## A\nBody <!-- words: w_000001 -->\n## B\n<!-- note -->\ntext");
    expect(outline.scenes.map((s) => s.wordRange)).toEqual([null, null]);
    expect(outline.scenes[1]!.words).toBe(2);
    expect(outline.warnings).toEqual([]);
  });

  it("warns and gives no range on a malformed comment, and still drops it from the word count", () => {
    for (const bad of ["<!-- words: w_1..w_2 -->", "<!-- words: -->", "<!-- words: w_000001..w_000002", "<!-- words: w_000001..w_000002..w_000003 -->", "<!-- words: w_000001 w_000002 -->"]) {
      const outline = parseScript(`## Intro\n${bad}\nHola.`);
      expect(outline.scenes[0]!.wordRange).toBeNull();
      expect(outline.scenes[0]!.words).toBe(1);
      expect(outline.warnings).toEqual([expect.stringMatching(/Scene "intro": malformed words comment/)]);
    }
  });

  it("ignores a comment inside a fenced block or not directly under a heading", () => {
    expect(scene("## A\ntext\n<!-- words: w_000001 -->").wordRange).toBeNull();
    expect(parseScript("## A\n```\n## B\n<!-- words: w_000001 -->\n```").scenes).toHaveLength(1);
  });
});

describe("script outline (scripts/*.md, SPEC §5.5)", () => {
  it("turns each level-2 heading into a scene with a slug, line range and word count", () => {
    const text = ["# Launch", "", "## Intro", "Hola a todos.", "", "## The demo", "Show the app running", "### Detail", "more words here"].join("\n");
    const outline = parseScript(text);
    expect(outline.scenes).toEqual([
      { title: "Intro", slug: "intro", line: 3, endLine: 5, words: 3, wordRange: null },
      { title: "The demo", slug: "the-demo", line: 6, endLine: 9, words: 8, wordRange: null },
    ]);
    expect(outline.meta).toEqual({ title: null, targetDuration: null, aspect: null });
    expect(outline.warnings).toEqual([]);
  });

  it("reads title, target_duration and aspect from YAML frontmatter; lines stay file lines", () => {
    const text = ["---", "title: Launch promo", "target_duration: 60", "aspect: '9:16'", "voice: ana", "---", "## Hook", "Buy it."].join("\n");
    const outline = parseScript(text);
    expect(outline.meta).toEqual({ title: "Launch promo", targetDuration: 60, aspect: "9:16" });
    expect(outline.scenes).toEqual([{ title: "Hook", slug: "hook", line: 7, endLine: 8, words: 2, wordRange: null }]);
    expect(outline.warnings).toEqual([]);
  });

  it("accepts target_duration as `90s`, `1:30` or `1m30s`", () => {
    const duration = (value: string) => parseScript(`---\ntarget_duration: "${value}"\n---\n`).meta.targetDuration;
    expect(duration("90s")).toBe(90);
    expect(duration("1:30")).toBe(90);
    expect(duration("1m30s")).toBe(90);
    expect(duration("2.5 s")).toBe(2.5);
  });

  it("warns, never fails, on bad frontmatter and keeps the scenes", () => {
    const broken = parseScript("---\ntitle: [unclosed\n---\n## Intro\n");
    expect(broken.meta.title).toBeNull();
    expect(broken.warnings).toEqual([expect.stringMatching(/^Frontmatter is not valid YAML/)]);
    expect(broken.scenes.map((scene) => scene.slug)).toEqual(["intro"]);

    const badValues = parseScript("---\ntitle: 3\ntarget_duration: soon\naspect: wide\n---\n");
    expect(badValues.meta).toEqual({ title: null, targetDuration: null, aspect: null });
    expect(badValues.warnings).toHaveLength(3);
    expect(badValues.warnings.join("\n")).toMatch(/target_duration/);

    const unclosed = parseScript("---\ntitle: x\n## Intro\n");
    expect(unclosed.warnings).toEqual([expect.stringMatching(/no closing `---`/)]);
    expect(unclosed.scenes.map((scene) => scene.slug)).toEqual(["intro"]);
  });

  it("gives duplicate headings GitHub-style suffixes and warns", () => {
    const outline = parseScript("## Take\n## Take\n## Take 1\n## Take\n");
    expect(outline.scenes.map((scene) => scene.slug)).toEqual(["take", "take-1", "take-1-1", "take-2"]);
    expect(outline.warnings).toEqual([expect.stringMatching(/"Take".*take-1.*take-2/)]);
  });

  it("keeps unicode letters in slugs and drops punctuation", () => {
    expect(scriptSlug("¿Por qué ñandú?")).toBe("por-qué-ñandú");
    expect(scriptSlug("Café — 2ª toma")).toBe("café--2ª-toma");
    expect(scriptSlug("日本語 の 見出し")).toBe("日本語-の-見出し");
    expect(scriptSlug("Straße")).toBe("straße");
    expect(scriptSlug("**Bold** `code` snake_case")).toBe("bold-code-snake_case");
    // NFD input slugs the same as NFC, so refs typed on any OS match.
    expect(scriptSlug("Canción".normalize("NFD"))).toBe(scriptSlug("Canción"));
  });

  it("names scenes whose heading has no letters or digits", () => {
    const outline = parseScript("## 🎬\n## !!!\n");
    expect(outline.scenes.map((scene) => scene.slug)).toEqual(["scene", "scene-1"]);
  });

  it("ignores headings inside fenced code, other levels and closing hashes", () => {
    const text = ["## Real ##", "```md", "## Not a scene", "```", "~~~", "## Nor this", "~~~", "#### Deep", "##No space", "   ## Indented"].join("\n");
    expect(parseScript(text).scenes.map((scene) => [scene.title, scene.slug])).toEqual([
      ["Real", "real"],
      ["Indented", "indented"],
    ]);
  });

  it("handles CRLF line endings and a BOM", () => {
    const outline = parseScript("\u{FEFF}---\r\ntitle: Hi\r\n---\r\n## Intro\r\nOne two\r\n");
    expect(outline.meta.title).toBe("Hi");
    expect(outline.scenes).toEqual([{ title: "Intro", slug: "intro", line: 4, endLine: 6, words: 2, wordRange: null }]);
  });
});

describe("splitScriptRef", () => {
  it("splits a scriptRef into project-relative path and anchor", () => {
    expect(splitScriptRef("scripts/script.md#intro")).toEqual({ path: "scripts/script.md", anchor: "intro" });
    expect(splitScriptRef("./scripts/a.md#x")).toEqual({ path: "scripts/a.md", anchor: "x" });
    expect(splitScriptRef("scripts\\a.md#x")).toEqual({ path: "scripts/a.md", anchor: "x" });
    expect(splitScriptRef("scripts/a.md")).toEqual({ path: "scripts/a.md", anchor: null });
    expect(splitScriptRef("scripts/a.md#")).toEqual({ path: "scripts/a.md", anchor: null });
  });
});

describe("isScriptPath", () => {
  it("accepts Markdown under scripts/ only, any letter case of the extension", () => {
    expect(isScriptPath("scripts/launch.md")).toBe(true);
    expect(isScriptPath("scripts/drafts/v2.MD")).toBe(true);
    expect(isScriptPath("README.md")).toBe(false);
    expect(isScriptPath("scripts/notes.txt")).toBe(false);
    expect(isScriptPath("scripts/.md")).toBe(false);
  });
});

describe("scriptRefPathProblem", () => {
  it("accepts project-relative paths", () => {
    expect(scriptRefPathProblem("scripts/script.md")).toBeNull();
    expect(scriptRefPathProblem("scripts/a..b.md")).toBeNull();
  });

  it("refuses paths that cannot name a project file", () => {
    const path = (ref: string) => splitScriptRef(ref).path;
    expect(scriptRefPathProblem(path("#intro"))).toMatch(/no script path/);
    expect(scriptRefPathProblem(path("/etc/hosts#x"))).toMatch(/absolute/);
    expect(scriptRefPathProblem(path("\\\\host\\share\\a.md#x"))).toMatch(/absolute/);
    expect(scriptRefPathProblem(path("C:/a.md#x"))).toMatch(/absolute/);
    expect(scriptRefPathProblem(path("c:a.md#x"))).toMatch(/absolute/);
    expect(scriptRefPathProblem(path("../x.md#s"))).toMatch(/`\.\.`/);
    expect(scriptRefPathProblem(path("scripts/../../x.md#s"))).toMatch(/`\.\.`/);
    expect(scriptRefPathProblem(path("scripts\\..\\..\\x.md#s"))).toMatch(/`\.\.`/);
    expect(scriptRefPathProblem(path("scripts/..#s"))).toMatch(/`\.\.`/);
    expect(scriptRefPathProblem("scripts/a\0.md")).toMatch(/NUL/);
  });
});

describe("shoot scripts (ADR 0023)", () => {
  const launch = [
    "---",
    "title: Launch video",
    "shoot: true",
    "source: drafts/guion.docx",
    "source_hash: 3F9A1C0E2B7D",
    "---",
    "",
    "## Hook (0:00–0:05)",
    "**Ana:** ¿Cuántas pestañas tenés abiertas ahora mismo?",
    "[VISUAL: Ana close-up, browser with 23 tabs behind]",
    "",
    "## The problem (0:05-1:02:10)",
    "**Ana:** Veintitrés. [beat] Yo *también*.",
    "**Juan**: Y ninguna la vas a [leer](https://example.com).",
    "[FREE: Juan tells how he lost a client]",
  ].join("\n");

  it("reads lines with held speakers, spoken words and cues at their word position", () => {
    const script = parseShootScript(launch);
    expect(script.shoot).toEqual({ shoot: true, source: "drafts/guion.docx", sourceHash: "3f9a1c0e2b7d", follow: "words" });
    expect(script.speakers).toEqual(["Ana", "Juan"]);
    expect(script.warnings).toEqual([]);
    const [hook, problem] = script.scenes;
    expect(hook!.lines).toEqual([
      { line: 9, speaker: "Ana", text: "¿Cuántas pestañas tenés abiertas ahora mismo?", words: ["Cuántas", "pestañas", "tenés", "abiertas", "ahora", "mismo"], cues: [] },
      { line: 10, speaker: "Ana", text: "", words: [], cues: [{ label: "VISUAL", text: "Ana close-up, browser with 23 tabs behind", at: 0, free: false }] },
    ]);
    expect(problem!.lines[0]).toMatchObject({ speaker: "Ana", text: "Veintitrés. Yo también.", words: ["Veintitrés", "Yo", "también"], cues: [{ label: "beat", text: null, at: 1, free: false }] });
    expect(problem!.lines[1]).toMatchObject({ speaker: "Juan", text: "Y ninguna la vas a leer.", cues: [] });
    expect(problem!.lines[2]).toMatchObject({ speaker: "Juan", words: [], cues: [{ label: "FREE", text: "Juan tells how he lost a client", free: true }] });
    expect(problem!.words).toBe(9);
  });

  it("takes the heading timing as expected length, out of title and slug", () => {
    const script = parseShootScript(launch);
    expect(script.scenes.map((scene) => [scene.title, scene.slug, scene.expected])).toEqual([
      ["Hook", "hook", 5],
      ["The problem", "the-problem", 3725],
    ]);
    expect(parseScript(launch).scenes.map((scene) => scene.slug)).toEqual(["hook", "the-problem"]);
    expect(parseScript("## Hook (0:00–0:05)\nHi").scenes[0]).toMatchObject({ title: "Hook (0:00–0:05)", slug: "hook-000005" });
    expect(parseShootScript("---\nshoot: true\n---\n## Hook (0:09–0:05)\nHi").warnings).toEqual([expect.stringMatching(/ends before it starts/)]);
  });

  it("never speaks headings, rules, comments, fenced code or list and quote marks", () => {
    const script = parseShootScript(["---", "shoot: true", "---", "## A", "### Note", "---", "<!-- aside --> Hola", "```", "code here", "```", "- uno", "> dos", "1. tres"].join("\n"));
    expect(script.scenes[0]!.lines.map((line) => line.text)).toEqual(["Hola", "uno", "dos", "tres"]);
    expect(script.speakers).toEqual([]);
    expect(script.warnings).toEqual([]);
  });

  it("warns, never fails, on broken conventions", () => {
    const text = ["---", "shoot: yes", "follow: vibes", "source: x.docx", "source_hash: nope", "---", "Intro line", "## A", "Hello <name>.", "**Ana:** Hi [TODO: fact]", "## B", "[VISUAL: logo]"].join("\n");
    const warnings = parseShootScript(text).warnings.join("\n");
    for (const expected of [/`shoot` must be `true`/, /`follow` must be/, /`source_hash` must be 12 hex/, /`source` has no `source_hash`/, /before the first `## `/, /placeholder <name>/, /placeholder \[TODO: fact\]/, /Line 9 comes before any `\*\*Name:\*\*`/, /Scene "b" has nothing to say/]) {
      expect(warnings).toMatch(expected);
    }
    expect(parseShootScript("## A\nHi").warnings).toEqual(["Not a shoot script: add `shoot: true` to the frontmatter."]);
    expect(parseShootScript("---\nshoot: true\nfollow: topics\n---\n").shoot.follow).toBe("topics");
    expect(parseShootScript("---\nshoot: true\n---\n").warnings).toEqual([expect.stringMatching(/^No scenes/)]);
  });

  it("matches speaker names ignoring case and keeps the first spelling", () => {
    const script = parseShootScript("---\nshoot: true\n---\n## A\n**ana:** uno\n**ANA:** dos\n**Ana Pérez:** tres");
    expect(script.speakers).toEqual(["ana", "Ana Pérez"]);
    expect(script.scenes[0]!.lines.map((line) => line.speaker)).toEqual(["ana", "ANA", "Ana Pérez"]);
  });
});
