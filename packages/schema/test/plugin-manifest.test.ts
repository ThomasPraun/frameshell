import { describe, expect, it } from "vitest";
import { PLUGIN_MANIFEST_FILE, parseExportPreset, parsePluginManifest } from "../src/index.js";

// Example taken verbatim from docs/SPEC.md §8.1.
const specExample = {
  name: "@frameshell/hyperframes",
  version: "0.1.0",
  apiVersion: "1",
  main: "dist/index.js",
  contributes: {
    clipTypes: ["hyperframes"],
    transcriptionProviders: [],
    commands: ["hyperframes new"],
    exportPresets: [],
    skills: ["skills/hyperframes/SKILL.md"],
  },
};

describe("plugin manifest (frameshell-plugin.json)", () => {
  it("is named as in the spec", () => {
    expect(PLUGIN_MANIFEST_FILE).toBe("frameshell-plugin.json");
  });

  it("accepts the spec example", () => {
    const result = parsePluginManifest(specExample);
    expect(result).toMatchObject({ ok: true, value: { name: "@frameshell/hyperframes", apiVersion: "1" } });
  });

  it("defaults missing contribution lists to empty", () => {
    const result = parsePluginManifest({ name: "tiny", version: "1.0.0", apiVersion: "1", main: "index.js" });
    expect(result).toMatchObject({
      ok: true,
      value: { contributes: { clipTypes: [], transcriptionProviders: [], commands: [], exportPresets: [], skills: [] } },
    });
  });

  it.each([
    ["apiVersion", { apiVersion: 1 }],
    ["apiVersion", { apiVersion: "v1" }],
    ["name", { name: "Not A Package" }],
    ["version", { version: "latest" }],
    ["main", { main: "../outside.js" }],
    ["main", { main: "/abs/index.js" }],
    ["contributes.commands.0", { contributes: { commands: ["justone"] } }],
    ["contributes.skills.0", { contributes: { skills: ["../../etc/passwd"] } }],
    ["unknownPoint", { contributes: { unknownPoint: [] } }],
  ])("rejects a bad %s with a message naming the field", (field, patch) => {
    const result = parsePluginManifest({ ...specExample, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(field);
  });

  it("rejects commands that would shadow a built-in CLI command", () => {
    const result = parsePluginManifest({ ...specExample, contributes: { commands: ["plugin install"] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/built-in/);
  });
});

describe("export preset", () => {
  const preset = {
    id: "square-1080",
    label: "Square 1080",
    container: "mp4",
    video: { codec: "h264", width: 1080, height: 1080, crf: 20 },
    audio: { codec: "aac", bitrateKbps: 192 },
    loudness: -14,
  };

  it("accepts a declarative preset", () => {
    expect(parseExportPreset(preset)).toMatchObject({ ok: true, value: { id: "square-1080" } });
  });

  it("rejects an unknown codec naming the field", () => {
    const result = parseExportPreset({ ...preset, video: { ...preset.video, codec: "divx" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("video.codec");
  });

  it("rejects a positive loudness target", () => {
    const result = parseExportPreset({ ...preset, loudness: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("loudness");
  });
});
