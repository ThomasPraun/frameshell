import type { AnalyzeAudio, AnalyzeEffect, AnalyzeEffects, AnalyzeSection, AnalyzeSentence, AnalyzeSpeech } from "@frameshell/protocol";
import type { Pcm16 } from "../transcripts/window.js";
import { HIT_FLOOR_DB, soundHits } from "./events.js";
import { pitchOf, pitchTrack } from "./pitch.js";
import { frameAt, frameStart } from "./shots.js";
import { type HeardWord, type Sentence, paceOf, sentenceText, sentencesOf } from "./speech.js";

// What the sound of a reference does (#471): sentences with pace, pitch and the voice against the music under it, effects over the
// music, and sections of steady level. Everything is read from the mix (its 10 ms energy envelope and a 16 kHz copy for the pitch),
// never from separated stems, so every figure is an estimate. Pure: `service.ts` decodes the sound and runs the transcription.

/** Level, dBFS RMS, under which nothing plays: the noise floor, the same line the hit detector uses. */
export const MUSIC_FLOOR_DB = HIT_FLOOR_DB;
/** Seconds around a word that count as voice: the envelope blurs over a few hops. */
const WORD_MARGIN_S = 0.03;
/** Seconds either side of a sentence the music under it is also read from. */
const MUSIC_REACH_S = 0.4;
/** Hops (10 ms) of music-only sound a sentence needs for its music level. */
const MUSIC_MIN_HOPS = 10;
/** The voice must stand this far over the mix for it to be told from the music: under it (0.5 dB) `voice` is null. */
const VOICE_MIN_RATIO = 1.122;
/** Rise of the sound, dB over the 80 ms before it, that makes an effect: 8 dB, so the music's own movement does not. */
export const EFFECT_RISE_DB = 8;
/** Seconds from a beat of a steady tempo within which a hit is the music's own. */
export const BEAT_TOLERANCE_S = 0.04;
/** Most effects `list` holds. */
export const MAX_EFFECTS = 100;
/** Seconds each level of the sections is taken over. */
const SECTION_WINDOW_S = 0.5;
/** Windows each side of a boundary its step is measured over (2 s). */
const SECTION_SPAN = 4;
/** dB of step that opens a section. */
export const SECTION_STEP_DB = 4;
/** Windows a section holds at least (4 s). */
const SECTION_MIN = 8;
/** Seconds from a downbeat within which a section's end sits on it. */
const DOWNBEAT_TOLERANCE_S = 0.1;

/** The tempo as the sections and effects use it. */
export interface AudioTempo {
  bpm: number;
  /** True when the grid is not trustworthy. */
  low: boolean;
  /** Seconds. */
  beats: readonly number[];
  downbeats: readonly number[];
}

/** What was heard of the speech: the words, or why there are none. */
export type SpeechInput =
  | { kind: "heard"; words: readonly HeardWord[]; pcm: Pcm16 | null; provider: string; model: string | null; language: string | null }
  | { kind: "skipped"; reason: string };

/** Input of {@link measureAudio}. */
export interface AudioMeasure {
  /** Energy envelope of the mix, dBFS RMS, one value per `hop` seconds (`energyEnvelope`). */
  db: ArrayLike<number>;
  hop: number;
  fps: number;
  /** Seconds of the film: the sections do not run past it. */
  duration: number;
  speech: SpeechInput;
  tempo: AudioTempo | null;
}

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const toDb = (power: number): number => 10 * Math.log10(power);
const toPower = (db: number): number => 10 ** (db / 10);

/** The span of seconds `[from, to)` as the hops of the envelope, clipped to `length`. */
function hopsOf(from: number, to: number, hop: number, length: number): [number, number] {
  return [Math.max(0, Math.min(length, Math.round(from / hop))), Math.max(0, Math.min(length, Math.round(to / hop)))];
}

/** 1 for each hop of the envelope that is within {@link WORD_MARGIN_S} of a word. */
export function voiceMask(words: readonly HeardWord[], hop: number, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const word of words) {
    const [from, to] = hopsOf(word.start - WORD_MARGIN_S, word.end + WORD_MARGIN_S, hop, length);
    mask.fill(1, from, Math.max(from, to));
  }
  return mask;
}

/** Mean level, dBFS, of the power of `db[from, to)`, over the hops `keep` accepts; null when none is kept. */
function meanLevel(db: ArrayLike<number>, from: number, to: number, keep: (index: number) => boolean = () => true): number | null {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    if (!keep(i)) continue;
    sum += toPower(db[i]!);
    count++;
  }
  return count === 0 ? null : toDb(sum / count);
}

/** The voice, the music under it and how far apart they are, for one sentence; see {@link AnalyzeSentence}. */
export function voiceAgainstMusic(db: ArrayLike<number>, hop: number, mask: Uint8Array, sentence: Sentence): { voice: number | null; music: number | null; voiceOverMusic: number | null } {
  // The mix over the words: the voice and whatever plays under it.
  let mixed = 0;
  let count = 0;
  for (const word of sentence.words) {
    const [from, to] = hopsOf(word.start, word.end, hop, db.length);
    for (let i = from; i < to; i++) {
      mixed += toPower(db[i]!);
      count++;
    }
  }
  if (count === 0) return { voice: null, music: null, voiceOverMusic: null };
  const mix = mixed / count;
  // The music alone: the hops around the sentence that no word covers (the gaps between its words, and a breath before and after it).
  const [from, to] = hopsOf(sentence.start - MUSIC_REACH_S, sentence.end + MUSIC_REACH_S, hop, db.length);
  const quiet: number[] = [];
  for (let i = from; i < to; i++) if (mask[i] === 0) quiet.push(db[i]!);
  quiet.sort((a, b) => a - b);
  const bed = quiet.length >= MUSIC_MIN_HOPS ? quiet[Math.floor(quiet.length / 2)]! : null;
  if (bed === null || bed < MUSIC_FLOOR_DB) return { voice: round(toDb(mix), 1), music: null, voiceOverMusic: null };
  const voice = mix > toPower(bed) * VOICE_MIN_RATIO ? toDb(mix - toPower(bed)) : null;
  return { voice: voice === null ? null : round(voice, 1), music: round(bed, 1), voiceOverMusic: voice === null ? null : round(voice - bed, 1) };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The skipped speech: no sentences. */
function skippedSpeech(reason: string): AnalyzeSpeech {
  return { status: "skipped", reason, provider: null, model: null, language: null, sentences: [], words: 0, speakingTime: 0, wordsPerSecond: null, pitch: null, overMusic: null };
}

/** The speech of the film: its sentences and how they sit on the music. */
export function speechOf(input: AudioMeasure, sentences: readonly Sentence[], mask: Uint8Array): AnalyzeSpeech {
  const { speech, db, hop, fps } = input;
  if (speech.kind === "skipped") return skippedSpeech(speech.reason);
  const everyTrack: number[] = [];
  const listed: AnalyzeSentence[] = sentences.map((sentence) => {
    const track = speech.pcm ? pitchTrack(speech.pcm.samples, speech.pcm.sampleRate, sentence.words.map((word) => [word.start, word.end] as const)) : [];
    everyTrack.push(...track);
    const startFrame = frameAt(sentence.start, fps);
    const endFrame = Math.max(startFrame + 1, frameAt(sentence.end, fps) + 1);
    return {
      startFrame,
      endFrame,
      start: frameStart(startFrame, fps),
      end: frameStart(endFrame, fps),
      text: sentenceText(sentence),
      words: sentence.words.length,
      pace: paceOf(sentence),
      pitch: pitchOf(track),
      ...voiceAgainstMusic(db, hop, mask, sentence),
    };
  });
  const words = listed.reduce((total, sentence) => total + sentence.words, 0);
  const speakingTime = sentences.reduce((total, sentence) => total + (sentence.end - sentence.start), 0);
  const gaps = listed.flatMap((sentence) => (sentence.voiceOverMusic === null ? [] : [sentence.voiceOverMusic]));
  return {
    status: "measured",
    reason: null,
    provider: speech.provider,
    model: speech.model,
    language: speech.language,
    sentences: listed,
    words,
    speakingTime: round(speakingTime, 3),
    wordsPerSecond: speakingTime > 0 ? round(words / speakingTime, 2) : null,
    pitch: pitchOf(everyTrack),
    overMusic: gaps.length === 0 ? null : { count: gaps.length, median: round(median(gaps), 1), lowest: Math.min(...gaps) },
  };
}

/**
 * The effects of the sound: hits that rise {@link EFFECT_RISE_DB} over the 80 ms before them, minus those that touch a word
 * (`mask`) and, when the tempo is steady, those on a beat (the music's own). An effect's level over the music is the
 * rise taken as a power ratio: peak = bed + effect, so effect over bed = 10^(rise / 10) - 1.
 */
export function effectsOf(input: AudioMeasure, mask: Uint8Array): AnalyzeEffects {
  const { db, hop, fps, tempo } = input;
  const steady = tempo !== null && !tempo.low;
  let onBeat = 0;
  const found: AnalyzeEffect[] = [];
  for (const hit of soundHits(db, hop, EFFECT_RISE_DB)) {
    const at = Math.round(hit.time / hop);
    let voiced = false;
    for (let i = Math.max(0, at - 8); i <= Math.min(mask.length - 1, at + 3); i++) voiced ||= mask[i] === 1;
    if (voiced) continue;
    if (steady && tempo.beats.some((beat) => Math.abs(beat - hit.time) <= BEAT_TOLERANCE_S)) {
      onBeat++;
      continue;
    }
    const bed = hit.level - hit.rise;
    const frame = frameAt(hit.time, fps);
    found.push({ frame, time: frameStart(frame, fps), level: hit.level, overMusic: bed < MUSIC_FLOOR_DB ? null : round(toDb(10 ** (hit.rise / 10) - 1), 1) });
  }
  const over = found.flatMap((effect) => (effect.overMusic === null ? [] : [effect.overMusic]));
  const minutes = (db.length * hop) / 60;
  return {
    count: found.length,
    perMinute: minutes > 0 ? round(found.length / minutes, 2) : 0,
    onBeat,
    overMusic: over.length === 0 ? null : { median: round(median(over), 1), loudest: Math.max(...over) },
    list: found.slice(0, MAX_EFFECTS),
  };
}

/** Level of each {@link SECTION_WINDOW_S} window of the sound, dBFS, over the hops `keep` accepts; a window with too few of them takes the one before it. */
function windowLevels(db: ArrayLike<number>, hop: number, keep: (index: number) => boolean): (number | null)[] {
  const size = Math.round(SECTION_WINDOW_S / hop);
  const levels: (number | null)[] = [];
  for (let from = 0; from < db.length; from += size) {
    const to = Math.min(db.length, from + size);
    let kept = 0;
    for (let i = from; i < to; i++) if (keep(i)) kept++;
    levels.push(kept >= Math.max(1, Math.floor(size / 5)) ? meanLevel(db, from, to, keep) : null);
  }
  return levels;
}

/** `levels` with each gap (null) filled by the level before it, or after it at the start; null when there is no level at all. */
function filled(levels: readonly (number | null)[]): number[] | null {
  const first = levels.find((level) => level !== null);
  if (first === undefined || first === null) return null;
  let last = first;
  return levels.map((level) => (last = level ?? last));
}

const mean = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Sections of the sound: where the level (the mix without the words) steps by {@link SECTION_STEP_DB} or more
 * between the 2 s before and the 2 s after, at least 4 s from another step and from either end. With a steady tempo a boundary
 * moves to the downbeat within a beat, and a section between two downbeats says its bars.
 */
export function sectionsOf(input: AudioMeasure, mask: Uint8Array | null, sentences: readonly Sentence[] | null): AnalyzeSection[] {
  const { db, hop, fps, tempo } = input;
  const end = Math.min(input.duration, db.length * hop);
  if (db.length === 0 || end <= 0) return [];
  const levels = (mask && filled(windowLevels(db, hop, (i) => mask[i] === 0))) ?? filled(windowLevels(db, hop, () => true))!;
  const n = levels.length;
  const score = new Float64Array(n);
  for (let i = SECTION_MIN; i <= n - SECTION_MIN; i++) {
    score[i] = Math.abs(mean(levels.slice(i, i + SECTION_SPAN)) - mean(levels.slice(Math.max(0, i - SECTION_SPAN), i)));
  }
  const peaks: number[] = [];
  for (let i = SECTION_MIN; i <= n - SECTION_MIN; i++) {
    if (score[i]! < SECTION_STEP_DB) continue;
    let peak = true;
    for (let j = Math.max(0, i - SECTION_SPAN + 1); j < Math.min(n, i + SECTION_SPAN); j++) if (j < i ? score[j]! >= score[i]! : score[j]! > score[i]!) peak = false;
    if (peak) peaks.push(i);
  }
  const accepted: number[] = [];
  for (const i of [...peaks].sort((a, b) => score[b]! - score[a]! || a - b)) if (accepted.every((other) => Math.abs(other - i) >= SECTION_MIN)) accepted.push(i);
  accepted.sort((a, b) => a - b);
  const edges = [0, ...accepted, n];

  const downbeats = tempo && !tempo.low ? tempo.downbeats : [];
  const beatSeconds = tempo ? 60 / tempo.bpm : 0;
  const nearest = (time: number): number => {
    let best = -1;
    for (const [index, downbeat] of downbeats.entries()) if (best < 0 || Math.abs(downbeat - time) < Math.abs(downbeats[best]! - time)) best = index;
    return best;
  };
  // A boundary inside the film moves to the downbeat within a beat; the ends of the sound only count as on one when it is within a tenth of a second.
  const bounds = edges.map((edge, k) => {
    const at = k === 0 ? 0 : k === edges.length - 1 ? end : edge * SECTION_WINDOW_S;
    const index = nearest(at);
    const interior = k > 0 && k < edges.length - 1;
    const tolerance = interior ? beatSeconds : DOWNBEAT_TOLERANCE_S;
    const snapped = index >= 0 && Math.abs(downbeats[index]! - at) <= tolerance;
    return { time: snapped && interior ? downbeats[index]! : at, downbeat: snapped ? index : null };
  });
  return edges.slice(0, -1).map((from, k) => {
    const to = edges[k + 1]!;
    const [start, stop] = [bounds[k]!, bounds[k + 1]!];
    const level = toDb(mean(levels.slice(from, to).map(toPower)));
    const before = k === 0 ? null : toDb(mean(levels.slice(edges[k - 1]!, from).map(toPower)));
    const startFrame = frameAt(start.time, fps);
    const endFrame = Math.max(startFrame + 1, frameAt(stop.time, fps));
    const covered = sentences?.reduce((total, sentence) => total + Math.max(0, Math.min(stop.time, sentence.end) - Math.max(start.time, sentence.start)), 0);
    return {
      startFrame,
      endFrame,
      start: frameStart(startFrame, fps),
      end: frameStart(endFrame, fps),
      level: round(level, 1),
      change: before === null ? null : round(level - before, 1),
      bars: start.downbeat !== null && stop.downbeat !== null && stop.downbeat > start.downbeat ? stop.downbeat - start.downbeat : null,
      speech: covered === undefined ? null : round(Math.min(1, covered / Math.max(1e-6, stop.time - start.time)), 2),
    };
  });
}

/** What the sound of the film does; see {@link AnalyzeAudio}. */
export function measureAudio(input: AudioMeasure): AnalyzeAudio {
  const heard = input.speech.kind === "heard";
  const sentences = input.speech.kind === "heard" ? sentencesOf(input.speech.words) : null;
  const mask = input.speech.kind === "heard" ? voiceMask(sentences!.flatMap((sentence) => sentence.words), input.hop, input.db.length) : null;
  return {
    speech: speechOf(input, sentences ?? [], mask ?? new Uint8Array(0)),
    effects: heard ? effectsOf(input, mask!) : null,
    sections: sectionsOf(input, mask, sentences),
  };
}
