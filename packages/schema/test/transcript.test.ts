import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SCHEMA_URL, parseTranscript, wordSpeaker } from "../src/index.js";

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

  it("accepts nextWordId above every word and edit id, and rejects one that is not", () => {
    expect(parseTranscript({ ...specExample, nextWordId: 3 }).ok).toBe(true);
    const wordAtMark = parseTranscript({ ...specExample, nextWordId: 2 });
    expect(wordAtMark.ok).toBe(false);
    if (!wordAtMark.ok) expect(wordAtMark.error).toMatch(/w_000002.*nextWordId 2/);
    const editAbove = parseTranscript({ ...specExample, nextWordId: 3, edits: { w_000009: { text: "x" } } });
    expect(editAbove.ok).toBe(false);
    if (!editAbove.ok) expect(editAbove.error).toMatch(/w_000009/);
    expect(parseTranscript({ ...specExample, nextWordId: 0 }).ok).toBe(false);
    expect(parseTranscript({ ...specExample, nextWordId: 2.5 }).ok).toBe(false);
  });

  it("rejects an asset hash that is not sha256", () => {
    expect(parseTranscript({ ...specExample, assetHash: "md5:abc" }).ok).toBe(false);
  });
});

describe("transcript speakers (ADR 0016)", () => {
  const withSpeakers = {
    ...specExample,
    words: [
      { id: "w_000001", text: "Hola", start: 0.52, end: 0.81, speaker: "s1" },
      { id: "w_000002", text: "a", start: 0.81, end: 0.88, speaker: "s2" },
    ],
    edits: { w_000002: { speaker: "s1" } },
    speakers: [
      { id: "s1", name: "Ana" },
      { id: "s2", name: "Speaker 2" },
    ],
  };

  it("accepts speakers on words, speaker corrections in edits and the speaker list", () => {
    expect(parseTranscript(withSpeakers)).toEqual({ ok: true, value: withSpeakers });
  });

  it("reads a word's speaker from its correction first", () => {
    const parsed = parseTranscript(withSpeakers);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.words.map((word) => wordSpeaker(parsed.value, word))).toEqual(["s1", "s1"]);
  });

  it("rejects a word or an edit naming a speaker the list lacks, and duplicate speaker ids", () => {
    const word = parseTranscript({ ...withSpeakers, speakers: [{ id: "s1", name: "Ana" }], edits: {} });
    expect(!word.ok && word.error).toMatch(/words\.1\.speaker[\s\S]*s2 is not in `speakers`/);
    const edit = parseTranscript({ ...withSpeakers, edits: { w_000001: { speaker: "s9" } } });
    expect(!edit.ok && edit.error).toMatch(/edits\.w_000001\.speaker/);
    const twice = parseTranscript({ ...withSpeakers, speakers: [...withSpeakers.speakers, { id: "s1", name: "Again" }] });
    expect(!twice.ok && twice.error).toMatch(/duplicate speaker id s1/);
  });

  it("rejects an empty edit and a malformed speaker id", () => {
    expect(parseTranscript({ ...withSpeakers, edits: { w_000001: {} } }).ok).toBe(false);
    expect(parseTranscript({ ...withSpeakers, speakers: [{ id: "ana", name: "Ana" }] }).ok).toBe(false);
  });
});
