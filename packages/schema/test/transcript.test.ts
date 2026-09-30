import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SCHEMA_URL, parseTranscript } from "../src/index.js";

// Example taken from docs/SPEC.md §5.4 (hash filled in).
const specExample = {
  schemaVersion: 1,
  asset: "assets/raw-01.mp4",
  assetHash: `sha256:${"ab".repeat(32)}`,
  provider: "whisper-cpp",
  model: "large-v3-turbo-q5_0",
  language: "es",
  words: [
    { id: "w_000001", text: "Hola", start: 0.52, end: 0.81, confidence: 0.97 },
    { id: "w_000002", text: "a", start: 0.81, end: 0.88, confidence: 0.95 },
  ],
  edits: { w_000002: { text: "a todos" } },
};

describe("transcript (transcripts/*.words.json)", () => {
  it("accepts the spec example", () => {
    const result = parseTranscript(specExample);
    expect(result).toEqual({ ok: true, value: specExample });
  });

  it("publishes a versioned $schema URL", () => {
    expect(TRANSCRIPT_SCHEMA_URL).toBe("https://frameshell.dev/schema/v1/transcript.json");
  });

  it("defaults edits to empty and accepts words without confidence", () => {
    const { edits: _omit, ...rest } = specExample;
    const result = parseTranscript({ ...rest, words: [{ id: "w_000001", text: "Hola", start: 0, end: 0.3 }] });
    expect(result.ok && result.value.edits).toEqual({});
  });

  it("rejects a word ending before it starts", () => {
    const result = parseTranscript({ ...specExample, words: [{ id: "w_000001", text: "x", start: 2, end: 1 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/words\.0/);
  });

  it("rejects duplicate word ids", () => {
    const word = { id: "w_000001", text: "x", start: 0, end: 1 };
    const result = parseTranscript({ ...specExample, words: [word, { ...word, start: 1, end: 2 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/w_000001/);
  });

  it("rejects an asset hash that is not sha256", () => {
    expect(parseTranscript({ ...specExample, assetHash: "md5:abc" }).ok).toBe(false);
  });
});
