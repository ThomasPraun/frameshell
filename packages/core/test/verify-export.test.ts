import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import { ErrorCode, methods } from "@frameshell/protocol";
import { type Timeline, parseTimeline, parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, type AudioInput, type TranscriberTools, verifyExport } from "../src/index.js";
import { tempDir } from "./helpers.js";

/**
 * Source take `assets/raw-01.mp4`, source seconds. Pauses at 1.4–2.2, 2.8–3.4,
 * 6.7–7.5 and 10.2–11.0. "vamos a ver" is said twice on purpose (a retake the
 * editor kept); w_000014 carries a two-word human edit.
 */
const SOURCE: [string, number, number][] = [
  ["Hola", 0.5, 0.8],
  ["a", 0.85, 0.95],
  ["todos,", 1.0, 1.4],
  ["eh", 2.2, 2.4],
  ["bueno", 2.45, 2.8],
  ["hoy", 3.4, 3.6],
  ["vamos", 3.65, 3.95],
  ["a", 4.0, 4.1],
  ["ver", 4.15, 4.4],
  ["vamos", 4.6, 4.9],
  ["a", 4.95, 5.05],
  ["ver", 5.1, 5.35],
  ["cómo", 5.45, 5.75],
  ["editar", 5.8, 6.2],
  ["vídeo.", 6.25, 6.7],
  ["Esto", 7.5, 7.75],
  ["es", 7.8, 7.95],
  ["muy", 8.0, 8.2],
  ["importante", 8.25, 8.9],
  ["para", 9.0, 9.2],
  ["veinte", 9.25, 9.6],
  ["personas.", 9.65, 10.2],
  ["Gracias", 11.0, 11.4],
  ["por", 11.45, 11.6],
  ["ver", 11.65, 11.95],
];

/**
 * Known cuts. c1 keeps 0.3–2.0 (clean, in the pause). c2 keeps 3.3–8.6 from
 * timeline 1.7: drops the filler "eh bueno", and its out point lands inside
 * "importante" (8.25–8.9, mostly kept: a word lost at the cut). c3 keeps
 * 11.1–12.2 at 1.3x from timeline 7.0: drops "para veinte personas.", and its
 * in point lands inside "Gracias" (11.0–11.4, mostly kept: lost at the cut).
 * Track a1 holds music with no transcript.
 */
function timeline(): Timeline {
  const parsed = parseTimeline({
    schemaVersion: 1,
    id: "main",
    revision: 7,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "c_0001", type: "media", asset: "assets/raw-01.mp4", start: 0, in: 0.3, out: 2.0 },
          { id: "c_0002", type: "media", asset: "assets/raw-01.mp4", start: 1.7, in: 3.3, out: 8.6 },
          { id: "c_0003", type: "media", asset: "assets/raw-01.mp4", start: 7.0, in: 11.1, out: 12.2, speed: 1.3 },
        ],
      },
      { id: "a1", kind: "audio", clips: [{ id: "c_0100", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 7.8 }] },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Timeline duration: c3 ends at 7.0 + 1.1 / 1.3. */
const TIMELINE_SECONDS = 7.846;

/**
 * What whisper hears in the export (timeline seconds), worked out by hand
 * from the cuts above, with the variations a second run shows: case,
 * punctuation and accents change, onsets move by up to 0.3 s, the edited
 * "editar un" comes back as two words, "muy" is misspelled, a filler "eh"
 * is added at the first join.
 */
const HEARD: Record<string, [string, number, number][]> = {
  c1: [
    ["hola", 0.25, 0.5],
    ["a", 0.6, 0.65],
    ["todos.", 0.72, 1.1],
    ["eh", 1.6, 1.7],
  ],
  c2FirstVamos: [
    ["vamos", 2.1, 2.35],
    ["a", 2.4, 2.5],
    ["ver", 2.6, 2.8],
  ],
  c2: [
    ["Hoy", 1.85, 2.0],
    ["vamos", 3.05, 3.3],
    ["a", 3.35, 3.45],
    ["ver", 3.5, 3.75],
    ["como", 3.9, 4.15],
    ["editar", 4.2, 4.45],
    ["un", 4.45, 4.6],
    ["video", 4.7, 5.1],
    ["esto", 5.95, 6.15],
    ["es", 6.2, 6.35],
    ["mui", 6.4, 6.6],
  ],
  importante: [["importante", 6.7, 7.0]],
  gracias: [["Gracias", 7.0, 7.2]],
  c3: [
    ["por", 7.3, 7.4],
    ["ver.", 7.45, 7.7],
  ],
};

function heard(...parts: string[]): TranscriptWord[] {
  return parts
    .flatMap((part) => HEARD[part]!)
    .sort((a, b) => a[1] - b[1])
    .map(([text, start, end]) => ({ text, start, end, confidence: 0.9 }));
}

function project(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), "{}");
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "transcripts"));
  mkdirSync(join(dir, "exports"));
  writeFileSync(join(dir, "assets", "raw-01.mp4"), "take");
  writeFileSync(join(dir, "assets", "music.wav"), "music");
  writeFileSync(join(dir, "exports", "main.mp4"), "export");
  const transcript = {
    schemaVersion: 1,
    asset: "assets/raw-01.mp4",
    assetHash: `sha256:${"a".repeat(64)}`,
    provider: "fake",
    model: "fake-large",
    language: "es",
    words: SOURCE.map(([text, start, end], i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text, start, end, confidence: 0.95 })),
    edits: { w_000014: { text: "editar un" } },
    nextWordId: SOURCE.length + 1,
  };
  if (!parseTranscript(transcript).ok) throw new Error("bad fixture transcript");
  writeFileSync(join(dir, "transcripts", "raw-01.words.json"), JSON.stringify(transcript));
  return dir;
}

/** What a re-check of export seconds `[from, to)` hears, on the export clock. */
type WindowHearing = (from: number, to: number) => TranscriptWord[];

/**
 * Provider replaying `words` for the whole export. A later call is a re-check
 * window: its start comes from the timecode audio of {@link fakeExtract}, and
 * it hears `window(from, to)` (default: the same as the full pass), returned
 * relative to the window like a real provider. Records what it was asked.
 */
function fakeProvider(words: TranscriptWord[], window?: WindowHearing) {
  const calls: { audio: string; options: unknown; window?: { from: number; to: number } }[] = [];
  const provider: TranscriptionProvider = {
    id: "fake",
    async transcribe(audio, options) {
      if (calls.length === 0) {
        calls.push({ audio, options });
        return { model: options.model ?? "fake-default", language: "es", words };
      }
      const wav = readFileSync(audio);
      const from = (wav.readInt16LE(44) * TIMECODE_STEP) / 16_000;
      const to = from + (wav.length - 44) / 2 / 16_000;
      calls.push({ audio, options, window: { from, to } });
      const heardThere = (window ?? ((a, b) => words.filter((word) => word.end > a && word.start < b)))(from, to);
      return {
        model: options.model ?? "fake-default",
        language: "es",
        words: heardThere.map((word) => ({ ...word, start: word.start - from, end: word.end - from })),
      };
    },
  };
  return { provider, calls };
}

/** Samples per timecode step of {@link timecodeWav}. */
const TIMECODE_STEP = 16;

/** 16 kHz mono WAV whose sample i holds `i / TIMECODE_STEP`: any slice tells where it starts (1 ms steps). */
function timecodeWav(seconds: number): Buffer {
  const count = Math.round(seconds * 16_000);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.floor(i / TIMECODE_STEP), 44 + i * 2);
  return wav;
}

const noTools: TranscriberTools = {
  ensureBinary: async (name) => `/bin/${name}`,
  ensureModel: async (id) => `/models/${id}`,
};

/** Extractor stand-in: a timecode WAV as long as the export. Records its inputs. */
function fakeExtract(seconds = TIMELINE_SECONDS) {
  const inputs: AudioInput[] = [];
  const extract: AudioExtractor = async (input, output) => {
    inputs.push(input);
    writeFileSync(output, timecodeWav(seconds));
  };
  return { extract, inputs };
}

function run(
  dir: string,
  words: TranscriptWord[],
  extra: Partial<Parameters<typeof verifyExport>[0]> = {},
  window?: WindowHearing,
) {
  const fake = fakeProvider(words, window);
  const extractor = fakeExtract();
  const result = verifyExport({
    projectDir: dir,
    exportFile: join(dir, "exports", "main.mp4"),
    timelineId: "main",
    timeline: timeline(),
    providerId: "fake",
    provider: fake.provider,
    tools: noTools,
    extractAudio: extractor.extract,
    ...extra,
  });
  return { result, calls: fake.calls, inputs: extractor.inputs };
}

describe("verifyExport", () => {
  it("reports exactly the words lost at the known cuts, with timeline position and source clip", async () => {
    const dir = project();
    const { result } = run(dir, heard("c1", "c2FirstVamos", "c2", "c3"));
    const report = await result;

    expect(methods["transcribe.verify"].result.parse(report)).toEqual(report);
    expect(report.lost).toEqual([
      {
        word: "w_000019",
        text: "importante",
        transcript: "transcripts/raw-01.words.json",
        asset: "assets/raw-01.mp4",
        track: "v1",
        clip: "c_0002",
        at: 6.65,
        end: 7,
        source: { start: 8.25, end: 8.9 },
        cut: { edge: "out", at: 7 },
        clipped: true,
        confidence: expect.any(Number),
      },
      {
        word: "w_000023",
        text: "Gracias",
        transcript: "transcripts/raw-01.words.json",
        asset: "assets/raw-01.mp4",
        track: "v1",
        clip: "c_0003",
        at: 7,
        end: 7.231,
        source: { start: 11, end: 11.4 },
        cut: { edge: "in", at: 7 },
        clipped: true,
        confidence: expect.any(Number),
      },
    ]);
    for (const word of report.lost) expect(word.confidence).toBeGreaterThanOrEqual(0.8);
    expect(report.uncertain).toEqual([]);
    expect(report).toMatchObject({
      timeline: "main",
      revision: 7,
      provider: "fake",
      expected: 20,
      heard: 18,
      unchecked: [{ clip: "c_0100", track: "a1", asset: "assets/music.wav", reason: "no-transcript" }],
    });
    expect(report.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("reports nothing when every kept word is heard, despite whisper's variations", async () => {
    const dir = project();
    const report = await run(dir, heard("c1", "c2FirstVamos", "c2", "importante", "gracias", "c3")).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain).toEqual([]);
    expect(report.heard).toBe(report.expected);
    expect(report.confidence).toBe(1);
  });

  it("keeps a repeated phrase whisper collapsed out of the lost list", async () => {
    // ADR 0003: one whisper run dropped a repeated phrase; that is not a cut loss.
    const dir = project();
    const report = await run(dir, heard("c1", "c2", "importante", "gracias", "c3")).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain.map((word) => [word.word, word.reason])).toEqual([
      ["w_000007", "repeat"],
      ["w_000008", "repeat"],
      ["w_000009", "repeat"],
    ]);
    for (const word of report.uncertain) expect(word.confidence).toBeLessThan(0.5);
  });

  it("flags a word at a cut heard as other text as uncertain, and a missing word away from cuts as unheard", async () => {
    const dir = project();
    const words = heard("c1", "c2FirstVamos", "c2", "importante", "c3").filter((word) => word.text !== "video");
    words.push({ text: "gra", start: 7.0, end: 7.1 });
    words.sort((a, b) => a.start - b.start);
    const report = await run(dir, words).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain).toEqual([
      expect.objectContaining({ word: "w_000015", reason: "unheard", cut: null, clipped: false, heardAs: null }),
      expect.objectContaining({ word: "w_000023", reason: "garbled", cut: { edge: "in", at: 7 }, heardAs: "gra" }),
    ]);
  });

  it("re-transcribes the export itself, in the source language, without writing a transcript", async () => {
    const dir = project();
    const { result, calls, inputs } = run(dir, heard("c1", "c2FirstVamos", "c2", "importante", "gracias", "c3"));
    const report = await result;
    expect(inputs).toEqual([{ path: join(dir, "exports", "main.mp4") }]);
    expect(calls).toEqual([{ audio: expect.stringContaining(join(dir, ".frameshell", "cache")), options: { model: "fake-large", language: "es" } }]);
    expect(existsSync(calls[0]!.audio)).toBe(false);
    expect(readdirSync(join(dir, "transcripts"))).toEqual(["raw-01.words.json"]);
    expect(report).toMatchObject({ export: join(dir, "exports", "main.mp4"), model: "fake-large", language: "es" });
    expect(report.duration).toEqual({ export: expect.closeTo(TIMELINE_SECONDS, 2), timeline: TIMELINE_SECONDS });
    expect(report.warnings).toEqual([]);
  });

  it("warns when the export is not as long as the timeline: it may predate the last edit", async () => {
    const dir = project();
    const extractor = fakeExtract(12);
    const report = await run(dir, heard("c1", "c2", "c3"), { extractAudio: extractor.extract }).result;
    expect(report.warnings).toEqual([expect.stringMatching(/export is 12(\.0+)? s.*timeline is 7\.846 s.*frameshell render/)]);
  });

  it("does not check clips whose transcript is stale", async () => {
    const dir = project();
    const report = await run(dir, heard("c1"), { assetHash: async () => `sha256:${"b".repeat(64)}` }).result;
    expect(report.expected).toBe(0);
    expect(report.lost).toEqual([]);
    expect(report.unchecked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clip: "c_0001", reason: "stale-transcript" }),
        expect.objectContaining({ clip: "c_0003", reason: "stale-transcript" }),
      ]),
    );
  });

  it("re-checks each word at a cut in its own audio window before reporting it lost", async () => {
    const dir = project();
    const { result, calls } = run(dir, heard("c1", "c2FirstVamos", "c2", "c3"));
    const report = await result;
    expect(report.lost.map((word) => word.word)).toEqual(["w_000019", "w_000023"]);
    // Both candidates sit within 5 s of each other: one window around them, clamped to the export.
    expect(calls.slice(1).map((call) => call.window)).toEqual([{ from: expect.closeTo(1.65, 2), to: expect.closeTo(TIMELINE_SECONDS, 2) }]);
    for (const call of calls) expect(existsSync(call.audio)).toBe(false);
  });

  it("does not report a word lost when its own window hears it (#115)", async () => {
    const dir = project();
    // The full pass skips "Hoy" (0.1 s inside c2's in point, not clipped); a window around it hears it.
    const all = heard("c1", "c2FirstVamos", "c2", "importante", "gracias", "c3");
    const full = all.filter((word) => word.text !== "Hoy" && word.text !== "eh");
    const report = await run(dir, full, {}, (from, to) => all.filter((word) => word.end > from && word.start < to)).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain).toEqual([]);
    expect(report.heard).toBe(report.expected);
  });

  it("reports a missed word whole inside its clip as unheard, never lost, even at a cut (#115)", async () => {
    const dir = project();
    const full = heard("c1", "c2FirstVamos", "c2", "importante", "gracias", "c3").filter((word) => word.text !== "Hoy" && word.text !== "eh");
    const report = await run(dir, full).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain).toEqual([
      expect.objectContaining({ word: "w_000006", reason: "unheard", cut: { edge: "in", at: 1.7 }, clipped: false, heardAs: null }),
    ]);
    expect(report.heard).toBe(report.expected - 1);
  });

  it("reports a clipped word heard as other text in its window as garbled", async () => {
    const dir = project();
    const report = await run(dir, heard("c1", "c2FirstVamos", "c2", "gracias", "c3"), {}, () => [
      { text: "casa", start: 6.7, end: 6.95 },
    ]).result;
    expect(report.lost).toEqual([]);
    expect(report.uncertain).toEqual([expect.objectContaining({ word: "w_000019", reason: "garbled", clipped: true, heardAs: "casa" })]);
  });

  it("fails with AssetNotFound for a missing export", async () => {
    const dir = project();
    await expect(run(dir, [], { exportFile: join(dir, "exports", "nope.mp4") }).result).rejects.toMatchObject({
      code: ErrorCode.AssetNotFound,
      message: expect.stringContaining("frameshell render"),
    });
  });
});
