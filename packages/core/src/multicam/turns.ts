import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";

/**
 * Who speaks when (ADR 0016 decision 3): speaking turns per angle from the
 * angles' own energy envelopes (`media/energy-store.ts`, one mic per person),
 * or from transcript speakers when people share a mic ({@link wordTurns}).
 * Pure: callers bring profiles, words and offsets.
 */

/** Resolution of the turns: one decision per frame, taking the loudest hop in it. */
export const TURN_FRAME_S = 0.05;
/** An angle starts speaking this far above its own quiet threshold (dB). */
const START_ABOVE_DB = 6;
/** Bleed margin: a voice more than this far below the loudest angle at the same time is that angle's bleed (dB). */
export const BLEED_DB = 12;
/** An ongoing turn survives levels this much lower than the start rules ask (dB): hysteresis against flicker. */
const HYSTERESIS_DB = 6;
/** Pauses shorter than this stay inside a turn (between words, breaths). */
export const MERGE_GAP_S = 0.5;
/** Shorter sounds are not turns (coughs, "mm"). */
export const MIN_TURN_S = 0.3;

/** One angle's mic, placed on the group clock. */
export interface TurnInput {
  /** Angle id in the group. */
  id: string;
  /** Group-clock second at which the file's time 0 plays; see `Angle.offset`. */
  offset: number;
  /** Angle gain in dB (`angle.audio.gain`), added to the mic's levels before mics are compared. Default 0. */
  gain?: number;
  /** Null: the file has no sound; the angle never speaks. */
  profile: EnergyProfile | null;
}

/** A stretch of group time during which one angle's person speaks. */
export interface Turn {
  /** Angle id in the group. */
  angle: string;
  /** Group-clock seconds, millisecond precision. */
  start: number;
  /** Group-clock seconds where the turn ends; greater than `start`. */
  end: number;
}

/**
 * Speaking turns of every angle on the group clock, sorted by start then angle
 * id. An angle is speaking where its mic is above its own quiet threshold and
 * no more than {@link BLEED_DB} below the loudest mic at that time, so one
 * voice heard in several mics counts for the nearest one only, while two
 * people talking at once both keep their turn (overlaps stay overlaps).
 * Hysteresis keeps a turn through dips; pauses under {@link MERGE_GAP_S}
 * are bridged unless another angle speaks in the pause, and sounds under
 * {@link MIN_TURN_S} dropped. Each mic's level includes its `gain`, so mics
 * recorded at very different volumes are levelled with the angle's gain.
 */
export function speakingTurns(inputs: readonly TurnInput[], duration: number): Turn[] {
  const frames = Math.ceil(duration / TURN_FRAME_S - 1e-9);
  const levels = inputs.map((input) => frameLevels(input, frames));
  const loudest = new Float32Array(frames).fill(Number.NEGATIVE_INFINITY);
  for (const level of levels) for (let f = 0; f < frames; f++) if (level[f]! > loudest[f]!) loudest[f] = level[f]!;

  const end = Math.round(duration * 1000) / 1000;
  const actives = inputs.map((input, i) => {
    const active = new Uint8Array(frames);
    if (!input.profile) return active;
    const threshold = input.profile.threshold + (input.gain ?? 0);
    const level = levels[i]!;
    let on = false;
    for (let f = 0; f < frames; f++) {
      const margin: number = on ? HYSTERESIS_DB : 0;
      on = level[f]! >= threshold + START_ABOVE_DB - margin && level[f]! >= loudest[f]! - BLEED_DB - margin;
      active[f] = on ? 1 : 0;
    }
    return active;
  });

  const turns: Turn[] = [];
  for (const [i, input] of inputs.entries()) {
    if (!input.profile) continue;
    const others = actives.filter((_, j) => j !== i);
    for (const [from, to] of dropShort(bridge(runs(actives[i]!), others))) {
      turns.push({ angle: input.id, start: seconds(from), end: Math.min(seconds(to), end) });
    }
  }
  return turns.sort((a, b) => a.start - b.start || (a.angle < b.angle ? -1 : a.angle > b.angle ? 1 : 0));
}

/** Loudest hop (dBFS) of each frame of the group clock; -Infinity where the file has no material. */
function frameLevels(input: TurnInput, frames: number): Float32Array {
  const out = new Float32Array(frames).fill(Number.NEGATIVE_INFINITY);
  if (!input.profile) return out;
  const { db } = input.profile;
  const gain = input.gain ?? 0;
  const hops = Math.round(TURN_FRAME_S / ENERGY_HOP_S);
  const shift = Math.round(input.offset / ENERGY_HOP_S);
  for (let f = 0; f < frames; f++) {
    const first = f * hops - shift;
    let max = Number.NEGATIVE_INFINITY;
    for (let h = Math.max(0, first); h < Math.min(db.length, first + hops); h++) if (db[h]! > max) max = db[h]!;
    out[f] = max + gain;
  }
  return out;
}

/** `[from, to)` frame runs of ones. */
function runs(active: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  for (let f = 0; f <= active.length; f++) {
    const on = f < active.length && active[f] === 1;
    if (on && from < 0) from = f;
    else if (!on && from >= 0) {
      out.push([from, f]);
      from = -1;
    }
  }
  return out;
}

/** Joins runs across short pauses, except pauses in which another angle speaks: that is not one turn. */
function bridge(list: [number, number][], others: readonly Uint8Array[]): [number, number][] {
  const out: [number, number][] = [];
  for (const run of list) {
    const last = out.at(-1);
    const quiet = last !== undefined && !others.some((other) => other.subarray(last[1], run[0]).includes(1));
    if (last && quiet && (run[0] - last[1]) * TURN_FRAME_S <= MERGE_GAP_S + 1e-9) last[1] = run[1];
    else out.push([...run]);
  }
  return out;
}

function dropShort(list: [number, number][]): [number, number][] {
  return list.filter(([from, to]) => (to - from) * TURN_FRAME_S >= MIN_TURN_S - 1e-9);
}

function seconds(frame: number): number {
  return Math.round(frame * TURN_FRAME_S * 1000) / 1000;
}

/** A transcript word with who says it (`edits` applied); source-asset seconds. */
export interface SpokenWord {
  start: number;
  end: number;
  speaker: string | undefined;
}

/**
 * Speaking turns of transcript speaker `speaker` on the group clock (file
 * time + `offset`), for a mic people share: runs of that speaker's words,
 * joined across pauses up to {@link MERGE_GAP_S} unless another speaker's
 * word comes between; turns under {@link MIN_TURN_S} dropped, as with energy.
 * Words without a speaker break nothing.
 */
export function wordTurns(words: readonly SpokenWord[], speaker: string, offset: number): Omit<Turn, "angle">[] {
  const sorted = words.filter((word) => word.speaker !== undefined).sort((a, b) => a.start - b.start);
  const runs: { start: number; end: number }[] = [];
  let open: { start: number; end: number } | null = null;
  for (const word of sorted) {
    if (word.speaker !== speaker) {
      open = null;
      continue;
    }
    const end = Math.max(word.end, word.start);
    if (open && word.start - open.end <= MERGE_GAP_S + 1e-9) open.end = Math.max(open.end, end);
    else {
      open = { start: word.start, end };
      runs.push(open);
    }
  }
  return runs
    .filter((run) => run.end - run.start >= MIN_TURN_S - 1e-9)
    .map((run) => ({ start: Math.round((offset + run.start) * 1000) / 1000, end: Math.round((offset + run.end) * 1000) / 1000 }));
}
