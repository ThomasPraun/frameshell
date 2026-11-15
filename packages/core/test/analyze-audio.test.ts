import { describe, expect, it } from "vitest";
import { type AudioMeasure, EFFECT_RISE_DB, effectsOf, measureAudio, sectionsOf, voiceAgainstMusic, voiceMask } from "../src/analyze/audio.js";
import { pitchOf, pitchTrack } from "../src/analyze/pitch.js";
import { paceOf, sentencesOf } from "../src/analyze/speech.js";

// The pure parts of `analyze` audio on synthetic envelopes and signals: nothing is decoded, nothing is transcribed.
const HOP = 0.01;

/** A power sum of two levels, dBFS. */
const mix = (a: number, b: number) => 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));

/** An envelope of `seconds` at `bed` dBFS with `stretches` (`[from, to, level]`, seconds) set over it. */
function envelope(seconds: number, bed: number, stretches: readonly (readonly [number, number, number])[] = []): Float32Array {
  const db = new Float32Array(Math.round(seconds / HOP)).fill(bed);
  for (const [from, to, level] of stretches) db.fill(level, Math.round(from / HOP), Math.round(to / HOP));
  return db;
}

function measure(db: Float32Array, extra: Partial<AudioMeasure> = {}): AudioMeasure {
  return { db, hop: HOP, fps: 30, duration: db.length * HOP, speech: { kind: "skipped", reason: "test" }, tempo: null, ...extra };
}

/** A voiced signal of 6 harmonics whose fundamental glides from `from` to `to` Hz over `seconds`, 16 kHz 16-bit. */
function voiced(seconds: number, from: number, to: number): Int16Array {
  const rate = 16_000;
  const out = new Int16Array(Math.round(seconds * rate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += (2 * Math.PI * (from + ((to - from) * i) / out.length)) / rate;
    let sample = 0;
    for (let k = 1; k <= 6; k++) sample += Math.sin(k * phase) / k;
    out[i] = Math.round(sample * 4000);
  }
  return out;
}

describe("pitch", () => {
  it("follows a gliding voice", () => {
    const pitch = pitchOf(pitchTrack(voiced(2, 120, 180), 16_000, [[0, 2]]));
    expect(pitch).not.toBeNull();
    expect(pitch!.median).toBeGreaterThan(145);
    expect(pitch!.median).toBeLessThan(155);
    expect(pitch!.low).toBeGreaterThan(120);
    expect(pitch!.high).toBeLessThan(182);
    // 126 to 174 Hz is 5.5 semitones.
    expect(pitch!.range).toBeGreaterThan(4.5);
    expect(pitch!.range).toBeLessThan(6.8);
    expect(pitch!.frames).toBeGreaterThan(80);
  });

  it("reads only inside the spans", () => {
    const track = pitchTrack(voiced(2, 150, 150), 16_000, [[0.5, 0.7]]);
    expect(track.length).toBeLessThanOrEqual(10);
    expect(pitchOf(track)).not.toBeNull();
  });

  it("finds none in noise or in silence", () => {
    let seed = 11;
    const noise = new Int16Array(32_000).map(() => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return Math.round((seed / 2 ** 32 - 0.5) * 8000);
    });
    expect(pitchOf(pitchTrack(noise, 16_000, [[0, 2]]))).toBeNull();
    expect(pitchOf(pitchTrack(new Int16Array(32_000), 16_000, [[0, 2]]))).toBeNull();
  });
});

describe("sentences", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });

  it("splits at a full stop, a question mark and a long pause, and counts only words", () => {
    const sentences = sentencesOf([w("Hello", 0, 0.4), w("there.", 0.5, 1), w("—", 1.1, 1.2), w("How", 1.3, 1.5), w("are", 1.6, 1.8), w("you?", 1.9, 2.2), w("Fine", 4, 4.4), w("thanks", 4.5, 5)]);
    expect(sentences.map((sentence) => sentence.words.map((word) => word.text))).toEqual([["Hello", "there."], ["How", "are", "you?"], ["Fine", "thanks"]]);
  });

  it("gives the pace in words per second over the span, null under 0.3 s", () => {
    const [sentence] = sentencesOf([w("a", 0, 0.2), w("b", 0.4, 0.6), w("c", 0.8, 1), w("d", 1.2, 1.5)]);
    expect(paceOf(sentence!)).toBe(2.67);
    expect(paceOf(sentencesOf([w("hi", 1, 1.2)])[0]!)).toBeNull();
  });
});

describe("voice against music", () => {
  // Music at -30 dBFS all along; a sentence of two words over it, the voice at -20 dBFS on its own.
  const words = [
    { text: "Come", start: 2, end: 2.6 },
    { text: "along.", start: 3, end: 3.8 },
  ];
  const withVoice = envelope(8, -30, [[2, 2.6, mix(-20, -30)], [3, 3.8, mix(-20, -30)]]);

  it("takes the music off the mix to find the voice, and says how far over it sits", () => {
    const [sentence] = sentencesOf(words);
    const found = voiceAgainstMusic(withVoice, HOP, voiceMask(words, HOP, withVoice.length), sentence!);
    expect(found.music).toBeCloseTo(-30, 0);
    expect(found.voice).toBeCloseTo(-20, 0);
    expect(found.voiceOverMusic).toBeCloseTo(10, 0);
  });

  it("gives the voice as the mix when nothing plays under it", () => {
    const quiet = envelope(8, -80, [[2, 2.6, -20], [3, 3.8, -20]]);
    const [sentence] = sentencesOf(words);
    const found = voiceAgainstMusic(quiet, HOP, voiceMask(words, HOP, quiet.length), sentence!);
    expect(found).toEqual({ voice: -20, music: null, voiceOverMusic: null });
  });

  it("has no voice figure when the music is as loud as the mix", () => {
    const buried = envelope(8, -30, [[2, 2.6, -29.8], [3, 3.8, -29.8]]);
    const [sentence] = sentencesOf(words);
    const found = voiceAgainstMusic(buried, HOP, voiceMask(words, HOP, buried.length), sentence!);
    expect(found.voice).toBeNull();
    expect(found.music).toBeCloseTo(-30, 0);
  });

  it("is carried by the sentences of the whole measure, with the summary of the overlaps", () => {
    const audio = measureAudio(measure(withVoice, { speech: { kind: "heard", words, pcm: null, provider: "test", model: "tiny", language: "en" } }));
    expect(audio.speech).toMatchObject({ status: "measured", provider: "test", model: "tiny", words: 2, pitch: null });
    expect(audio.speech.sentences).toHaveLength(1);
    expect(audio.speech.sentences[0]).toMatchObject({ startFrame: 60, words: 2, text: "Come along." });
    expect(audio.speech.sentences[0]!.pace).toBeCloseTo(1.11, 2);
    expect(audio.speech.overMusic).toMatchObject({ count: 1 });
    expect(audio.speech.overMusic!.median).toBeCloseTo(10, 0);
    // 1.8 s from the first word to the last.
    expect(audio.speech.speakingTime).toBe(1.8);
  });
});

describe("effects", () => {
  // Music at -30 dBFS; effects 14 dB over it at 3 s and 7 s, a word at 5 s, and a hit at 9 s on the beat of a steady tempo.
  const db = envelope(12, -30, [[3, 3.15, mix(-16, -30)], [7, 7.15, mix(-16, -30)], [5, 5.4, mix(-12, -30)], [9, 9.1, mix(-16, -30)]]);
  const words = [{ text: "now", start: 5, end: 5.4 }];

  it("finds the hits that are neither a word nor the music's beat, with their level over the music", () => {
    const mask = voiceMask(words, HOP, db.length);
    const effects = effectsOf(measure(db, { tempo: { bpm: 60, low: false, beats: [1, 2, 9, 10], downbeats: [1] } }), mask);
    expect(effects.list.map((effect) => effect.time)).toEqual([3, 7]);
    expect(effects.onBeat).toBe(1);
    expect(effects.count).toBe(2);
    for (const effect of effects.list) {
      expect(effect.overMusic).toBeGreaterThan(13.5);
      expect(effect.overMusic).toBeLessThan(14.5);
      expect(effect.level).toBeGreaterThan(-16.5);
    }
    expect(effects.overMusic!.loudest).toBeGreaterThan(13.5);
    expect(effects.perMinute).toBe(10);
  });

  it("keeps the hit on a beat when the tempo is not trustworthy", () => {
    const mask = voiceMask(words, HOP, db.length);
    const effects = effectsOf(measure(db, { tempo: { bpm: 60, low: true, beats: [9], downbeats: [] } }), mask);
    expect(effects.list.map((effect) => effect.time)).toEqual([3, 7, 9]);
    expect(effects.onBeat).toBe(0);
  });

  it("gives no level over music for an effect over silence", () => {
    const quiet = envelope(6, -90, [[3, 3.15, -16]]);
    const effects = effectsOf(measure(quiet), voiceMask([], HOP, quiet.length));
    expect(effects.list).toHaveLength(1);
    expect(effects.list[0]!.overMusic).toBeNull();
    expect(effects.overMusic).toBeNull();
  });

  it("needs a rise of more than the threshold", () => {
    const soft = envelope(6, -30, [[3, 3.15, -30 + EFFECT_RISE_DB / 2]]);
    expect(effectsOf(measure(soft), voiceMask([], HOP, soft.length)).count).toBe(0);
  });
});

describe("sections", () => {
  // Bed at -40 dBFS for 10 s, then -25 dBFS for 10 s: one step of 15 dB. A downbeat every 2 s (120 BPM in 4).
  const downbeats = Array.from({ length: 11 }, (_, i) => i * 2);
  const tempo = { bpm: 120, low: false, beats: downbeats, downbeats };
  const db = envelope(20, -40, [[10, 20, -25]]);

  it("starts a new section at the step, on the downbeat, and counts the bars", () => {
    const sections = sectionsOf(measure(db, { tempo }), null, null);
    expect(sections.map((section) => [section.start, section.end])).toEqual([[0, 10], [10, 20]]);
    expect(sections.map((section) => section.level)).toEqual([-40, -25]);
    expect(sections.map((section) => section.change)).toEqual([null, 15]);
    expect(sections.map((section) => section.bars)).toEqual([5, 5]);
    expect(sections.map((section) => section.speech)).toEqual([null, null]);
  });

  it("puts the boundary where the step is without a tempo, and leaves the bars out", () => {
    const sections = sectionsOf(measure(db), null, null);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.end).toBeGreaterThanOrEqual(9.9);
    expect(sections[0]!.end).toBeLessThanOrEqual(10.6);
    expect(sections.map((section) => section.bars)).toEqual([null, null]);
  });

  it("is one section for a steady sound, and ignores a step under 4 dB", () => {
    expect(sectionsOf(measure(envelope(20, -30)), null, null)).toHaveLength(1);
    expect(sectionsOf(measure(envelope(20, -30, [[10, 20, -27]])), null, null)).toHaveLength(1);
  });

  it("keeps steps closer than 4 s to the end out of it", () => {
    expect(sectionsOf(measure(envelope(20, -30, [[18, 20, -10]])), null, null)).toHaveLength(1);
  });

  it("leaves the words out of the level, so a voice does not open a section", () => {
    const words = [{ text: "talking", start: 4, end: 14 }];
    const loud = envelope(20, -30, [[4, 14, -12]]);
    expect(sectionsOf(measure(loud), voiceMask(words, HOP, loud.length), sentencesOf(words))).toHaveLength(1);
    // Counted in, the same voice makes three.
    expect(sectionsOf(measure(loud), null, null).length).toBeGreaterThan(1);
  });

  it("says how much of each section the speech covers", () => {
    const words = [{ text: "talking", start: 4, end: 8 }];
    const talking = envelope(20, -40, [[4, 8, -15], [10, 20, -25]]);
    const sections = sectionsOf(measure(talking), voiceMask(words, HOP, talking.length), sentencesOf(words));
    expect(sections.map((section) => section.speech)).toEqual([0.4, 0]);
  });
});

describe("measureAudio", () => {
  it("skips the speech and the effects with the reason, and still gives the sections", () => {
    const audio = measureAudio(measure(envelope(20, -40, [[10, 20, -25]]), { speech: { kind: "skipped", reason: "no transcription is set up here." } }));
    expect(audio.speech).toMatchObject({ status: "skipped", reason: "no transcription is set up here.", sentences: [], words: 0, wordsPerSecond: null });
    expect(audio.effects).toBeNull();
    expect(audio.sections).toHaveLength(2);
  });

  it("has no sentences and zero effects for music alone", () => {
    const audio = measureAudio(measure(envelope(20, -30), { speech: { kind: "heard", words: [], pcm: null, provider: "test", model: null, language: null } }));
    expect(audio.speech).toMatchObject({ status: "measured", sentences: [], words: 0, wordsPerSecond: null, overMusic: null });
    expect(audio.effects).toMatchObject({ count: 0, list: [], overMusic: null });
  });
});
