import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { AnalyzeService } from "../src/analyze/service.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run } from "./media-tools.js";

// `analyze` audio through the service with real ffmpeg on a 12 s film: a music bed at -30 dBFS, two spoken sentences with a
// gliding voice at -20 dBFS (words known by a fake transcription), and a 0.1 s effect 14 dB over the music. Sound encoded as AAC.
const MEDIA_TIMEOUT = 240_000;
const RATE = 48_000;

const WORDS = [
  { text: "Welcome", start: 1, end: 1.5 },
  { text: "to", start: 1.6, end: 1.8 },
  { text: "the", start: 1.9, end: 2.1 },
  { text: "show.", start: 2.2, end: 3 },
  { text: "Next", start: 5, end: 5.4 },
  { text: "up.", start: 5.5, end: 6.2 },
];

/** `samples` scaled to an RMS of `db` dBFS over the whole span. */
function scaled(samples: Float32Array, db: number): Float32Array {
  let power = 0;
  for (const sample of samples) power += sample * sample;
  const gain = 10 ** (db / 20) / Math.sqrt(power / samples.length);
  return samples.map((sample) => sample * gain);
}

/** The film's sound as float samples: music + voice + effect. */
function soundOf(): Float32Array {
  const out = new Float32Array(12 * RATE);
  const tones = [220, 277.18, 329.63];
  out.set(scaled(Float32Array.from({ length: out.length }, (_, i) => tones.reduce((total, f) => total + Math.sin((2 * Math.PI * f * i) / RATE), 0)), -30));
  for (const word of WORDS) {
    const from = Math.round(word.start * RATE);
    const length = Math.round((word.end - word.start) * RATE);
    let phase = 0;
    const voice = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      phase += (2 * Math.PI * (130 + (40 * i) / length)) / RATE;
      let sample = 0;
      for (let k = 1; k <= 6; k++) sample += Math.sin(k * phase) / k;
      voice[i] = sample;
    }
    scaled(voice, -20).forEach((sample, i) => (out[from + i] = out[from + i]! + sample));
  }
  const burst = scaled(Float32Array.from({ length: Math.round(0.1 * RATE) }, (_, i) => Math.sin((2 * Math.PI * 1_400 * i) / RATE)), -16);
  burst.forEach((sample, i) => (out[8 * RATE + i] = out[8 * RATE + i]! + sample));
  return out;
}

let film: string;
let service: AnalyzeService;
let silent: string;

/** A service whose beat detector finds no beat in anything. */
function serviceOver(tools: { ffmpeg: string; ffprobe: string }, transcribe?: ConstructorParameters<typeof AnalyzeService>[0]["transcribe"]): AnalyzeService {
  return new AnalyzeService({
    ffmpeg: async () => tools.ffmpeg,
    ffprobe: async () => tools.ffprobe,
    beats: {
      measureAudio: async () => {
        throw new RpcError(ErrorCode.InvalidOperation, "No beats in test: nothing steady.", { reason: "no beats" });
      },
    },
    ...(transcribe ? { transcribe } : {}),
  });
}

beforeAll(async () => {
  const tools = await mediaTools();
  const footage = tempDir();
  writeFileSync(join(footage, "sound.wav"), wavOf(soundOf().map((sample) => sample * 2), RATE));
  film = join(footage, "Talk.mp4");
  await run(tools.ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=12", "-i", join(footage, "sound.wav")],
    ...["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", film],
  ]);
  silent = join(footage, "Silent.mp4");
  await run(tools.ffmpeg, [...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=2"], ...["-c:v", "libx264", "-pix_fmt", "yuv420p", silent]]);
  service = serviceOver(tools, async () => ({ words: WORDS, provider: "fake", model: "tiny", language: "en" }));
}, MEDIA_TIMEOUT);

describe("analyze audio", () => {
  it(
    "finds the sentences with their pace, pitch and voice over the music, and the effect over the music",
    async () => {
      const root = tempDir();
      const result = await service.run(root, { file: film });
      const audio = result.audio!;
      expect(audio.speech).toMatchObject({ status: "measured", reason: null, provider: "fake", model: "tiny", language: "en", words: 6 });
      expect(audio.speech.sentences.map((sentence) => [sentence.start, sentence.words, sentence.text])).toEqual([
        [1, 4, "Welcome to the show."],
        [5, 2, "Next up."],
      ]);
      const [first, second] = audio.speech.sentences;
      // Four words over the 2 s from the first word to the last.
      expect(first!.pace).toBe(2);
      // Two words over the 1.2 s.
      expect(second!.pace).toBe(1.67);
      expect(audio.speech.wordsPerSecond).toBeCloseTo(1.88, 2);
      for (const sentence of audio.speech.sentences) {
        expect(sentence.music!).toBeGreaterThan(-32.5);
        expect(sentence.music!).toBeLessThan(-27.5);
        expect(sentence.voice!).toBeGreaterThan(-22);
        expect(sentence.voice!).toBeLessThan(-18);
        expect(sentence.voiceOverMusic!).toBeGreaterThan(7);
        expect(sentence.voiceOverMusic!).toBeLessThan(13);
        // The voice glides from 130 to 170 Hz.
        expect(sentence.pitch!.median).toBeGreaterThan(125);
        expect(sentence.pitch!.median).toBeLessThan(175);
      }
      expect(audio.speech.pitch!.frames).toBeGreaterThan(30);
      expect(audio.speech.overMusic!.count).toBe(2);

      expect(audio.effects!.count).toBe(1);
      const [effect] = audio.effects!.list;
      expect(effect!.time).toBeGreaterThanOrEqual(7.9);
      expect(effect!.time).toBeLessThanOrEqual(8.1);
      expect(effect!.overMusic!).toBeGreaterThan(11);
      expect(effect!.overMusic!).toBeLessThan(17);

      expect(audio.sections).toHaveLength(1);
      expect(audio.sections[0]).toMatchObject({ startFrame: 0, change: null, bars: null });
      expect(audio.sections[0]!.speech!).toBeGreaterThan(0.2);
      expect(audio.sections[0]!.level).toBeGreaterThan(-32);
      expect(result.warnings.filter((warning) => warning.startsWith("audio:"))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "skips the speech and the effects, with the reason, when asked not to recognise it, and still gives the sections",
    async () => {
      const result = await service.run(tempDir(), { file: film, speech: false });
      expect(result.audio!.speech).toMatchObject({ status: "skipped", reason: "not asked for (speech: false).", sentences: [] });
      expect(result.audio!.effects).toBeNull();
      // Nothing says where the words are, so the voice counts in the level and its steps may open sections.
      expect(result.audio!.sections.length).toBeGreaterThanOrEqual(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "skips the speech with the reason when the recognition fails or nothing is set up",
    async () => {
      const tools = await mediaTools();
      const failing = serviceOver(tools, async () => {
        throw new Error("model missing");
      });
      const failed = await failing.run(tempDir(), { file: film });
      expect(failed.audio!.speech).toMatchObject({ status: "skipped", reason: "the speech could not be recognised: model missing" });
      const unset = await serviceOver(tools).run(tempDir(), { file: film });
      expect(unset.audio!.speech).toMatchObject({ status: "skipped", reason: "no transcription is set up here." });
      // The reason is in `speech`, not in the warnings (the only one here is the tempo one).
      expect([...failed.warnings, ...unset.warnings].filter((warning) => warning.startsWith("audio:"))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "has no audio for a film without sound",
    async () => {
      const result = await service.run(tempDir(), { file: silent });
      expect(result.audio).toBeNull();
    },
    MEDIA_TIMEOUT,
  );
});
