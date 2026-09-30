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
  editing: { snapWindow: 0.5 },
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

  it("takes editing.snapWindow as the project default snap window", () => {
    const result = parseProjectConfig({ ...specExample, editing: { snapWindow: 1.25 } });
    expect(result.ok && result.value.editing?.snapWindow).toBe(1.25);
    expect(parseProjectConfig({ ...specExample, editing: {} }).ok).toBe(true);
  });

  it("rejects a snap window below 0.5 s with a fix", () => {
    const result = parseProjectConfig({ ...specExample, editing: { snapWindow: 0.2 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^editing\.snapWindow: /);
      expect(result.error).toMatch(/0\.5/);
      expect(result.error).toMatch(/0\.2/);
      expect(result.error).toMatch(/remove/i);
    }
  });

  it("rejects a snap window above 10 s and unknown editing keys", () => {
    expect(parseProjectConfig({ ...specExample, editing: { snapWindow: 11 } }).ok).toBe(false);
    const typo = parseProjectConfig({ ...specExample, editing: { snapWindow: 1, snapWindw: 1 } });
    expect(typo.ok).toBe(false);
  });
});
