import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIdea, formatSize, planIdeaProject } from "../src/main/idea-project.js";
import { ideaPrompt } from "../src/renderer/src/idea.js";

describe("planIdeaProject", () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "idea-"));
  });
  afterEach(() => rm(parent, { recursive: true, force: true }));

  it("puts the project in a folder of its name and numbers a taken one", async () => {
    expect(await planIdeaProject({ parent, name: "Launch film" })).toEqual({ parent, name: "Launch film", dir: join(parent, "Launch film") });
    await mkdir(join(parent, "Launch film"));
    expect((await planIdeaProject({ parent, name: "Launch film" })).dir).toBe(join(parent, "Launch film (2)"));
  });

  it("makes the name safe for a folder and never empty", async () => {
    expect((await planIdeaProject({ parent, name: "a/b: c?" })).name).toBe("a-b- c-");
    expect((await planIdeaProject({ parent, name: "" })).name).toBe("Untitled video");
  });
});

describe("checkIdea", () => {
  const brief = { name: "  Reel  ", formats: ["9x16", "16x9"], seconds: 30, url: " https://example.com/a " };

  it("trims, orders the formats like the built-in list and normalises the address", () => {
    expect(checkIdea(brief)).toEqual({ name: "Reel", formats: ["16x9", "9x16"], seconds: 30, url: "https://example.com/a" });
  });

  it("accepts no length and no address", () => {
    expect(checkIdea({ ...brief, seconds: null, url: "  " })).toMatchObject({ seconds: null, url: null });
  });

  it("refuses what cannot make a project", () => {
    expect(() => checkIdea({ ...brief, name: " " })).toThrow(/name/);
    expect(() => checkIdea({ ...brief, formats: [] })).toThrow(/format/);
    expect(() => checkIdea({ ...brief, formats: ["nope"] })).toThrow(/format/);
    expect(() => checkIdea({ ...brief, seconds: 0 })).toThrow(/length/);
    expect(() => checkIdea({ ...brief, url: "file:///etc/passwd" })).toThrow(/web address/);
    expect(() => checkIdea({ ...brief, url: "not a url" })).toThrow(/web address/);
  });
});

describe("formatSize", () => {
  it("is the canvas of a built-in format", () => {
    expect(formatSize("9x16")).toEqual({ width: 1080, height: 1920 });
    expect(() => formatSize("nope")).toThrow();
  });
});

describe("ideaPrompt", () => {
  it("carries the brief and the full-pass asks, and names no command", () => {
    const prompt = ideaPrompt({ name: "Reel", formats: ["16x9", "9x16"], seconds: 45, url: "https://example.com/" });
    expect(prompt).toContain('"Reel"');
    expect(prompt).toContain("Horizontal 16:9 (1920x1080), Vertical 9:16 (1080x1920)");
    expect(prompt).toContain("https://example.com/");
    expect(prompt).toMatch(/three storylines/);
    expect(prompt).toMatch(/free alternative/);
    expect(prompt).not.toMatch(/frameshell [a-z]+ [a-z]+/);
  });

  it("leaves out the length and the address when there are none", () => {
    const prompt = ideaPrompt({ name: "Reel", formats: ["1x1"], seconds: null, url: null });
    expect(prompt).not.toMatch(/Length:|Start from this page/);
  });
});
