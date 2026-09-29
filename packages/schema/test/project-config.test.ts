import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, parseProjectConfig } from "../src/index.js";

// Example taken verbatim from docs/SPEC.md §5.2.
const specExample = {
  $schema: "https://frameshell.dev/schema/v1/project.json",
  schemaVersion: 1,
  name: "Launch video",
  fps: 30,
  resolution: { width: 2560, height: 1440 },
  sampleRate: 48000,
  main: "timelines/main.json",
  plugins: {
    "@frameshell/hyperframes": "0.1.0",
    "@frameshell/whisper-cpp": "0.1.0",
  },
  transcription: { provider: "whisper-cpp", model: "large-v3-turbo", language: "es" },
  binaries: { ffmpeg: "managed" },
  export: { defaultPreset: "youtube-1440p", loudness: -17 },
};

describe("project config (frameshell.json)", () => {
  it("accepts the spec example", () => {
    const result = parseProjectConfig(specExample);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Launch video");
  });

  it("publishes schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("rejects a missing schemaVersion with a message naming the field", () => {
    const { schemaVersion: _omit, ...withoutVersion } = specExample;
    const result = parseProjectConfig(withoutVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schemaVersion/);
  });

  it("rejects a non-positive fps", () => {
    const result = parseProjectConfig({ ...specExample, fps: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fps/);
  });
});
