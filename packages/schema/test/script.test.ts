import { describe, expect, it } from "vitest";
import { parseScript, scriptRefPathProblem, scriptSlug, splitScriptRef } from "../src/index.js";

describe("script outline (scripts/*.md, SPEC §5.5)", () => {
  it("turns each level-2 heading into a scene with a slug, line range and word count", () => {
    const text = ["# Launch", "", "## Intro", "Hola a todos.", "", "## The demo", "Show the app running", "### Detail", "more words here"].join("\n");
    const outline = parseScript(text);
    expect(outline.scenes).toEqual([
      { title: "Intro", slug: "intro", line: 3, endLine: 5, words: 3 },
      { title: "The demo", slug: "the-demo", line: 6, endLine: 9, words: 8 },
    ]);
    expect(outline.meta).toEqual({ title: null, targetDuration: null, aspect: null });
    expect(outline.warnings).toEqual([]);
  });

  it("reads title, target_duration and aspect from YAML frontmatter; lines stay file lines", () => {
    const text = ["---", "title: Launch promo", "target_duration: 60", "aspect: '9:16'", "voice: ana", "---", "## Hook", "Buy it."].join("\n");
    const outline = parseScript(text);
    expect(outline.meta).toEqual({ title: "Launch promo", targetDuration: 60, aspect: "9:16" });
    expect(outline.scenes).toEqual([{ title: "Hook", slug: "hook", line: 7, endLine: 8, words: 2 }]);
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
    expect(outline.scenes).toEqual([{ title: "Intro", slug: "intro", line: 4, endLine: 6, words: 2 }]);
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
