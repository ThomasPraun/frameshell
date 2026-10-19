import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";

/**
 * Who speaks when (ADR 0016 decision 3, one mic per person): speaking turns
 * per angle from the angles' own energy envelopes (`media/energy-store.ts`).
 * Pure: callers bring profiles and offsets.
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
  id: string;
  /** Group-clock second at which the file's time 0 plays; see `Angle.offset`. */
  offset: number;
  /** Null: the file has no sound; the angle never speaks. */
  profile: EnergyProfile | null;
}

/** A stretch of group time during which one angle's person speaks. */
export interface Turn {
  angle: string;
  /** Group-clock seconds, millisecond precision. */
  start: number;
  end: number;
}

/**
 * Speaking turns of every angle on the group clock, sorted by start then angle
 * id. An angle is speaking where its mic is above its own quiet threshold and
 * no more than {@link BLEED_DB} below the loudest mic at that time, so one
 * voice heard in several mics counts for the nearest one only, while two
 * people talking at once both keep their turn (overlaps stay overlaps).
 * Hysteresis keeps a turn through dips; pauses under {@link MERGE_GAP_S}
 * are bridged and sounds under {@link MIN_TURN_S} dropped. Levels are compared
 * as recorded: mics set to very different gains need the louder one's gain
 * lowered first.
 */
export function speakingTurns(inputs: readonly TurnInput[], duration: number): Turn[] {
  const frames = Math.ceil(duration / TURN_FRAME_S - 1e-9);
  const levels = inputs.map((input) => frameLevels(input, frames));
  const loudest = new Float32Array(frames).fill(Number.NEGATIVE_INFINITY);
  for (const level of levels) for (let f = 0; f < frames; f++) if (level[f]! > loudest[f]!) loudest[f] = level[f]!;

  const end = Math.round(duration * 1000) / 1000;
  const turns: Turn[] = [];
  for (const [i, input] of inputs.entries()) {
    if (!input.profile) continue;
    const { threshold } = input.profile;
    const level = levels[i]!;
    const active = new Uint8Array(frames);
    let on = false;
    for (let f = 0; f < frames; f++) {
      const margin: number = on ? HYSTERESIS_DB : 0;
      on = level[f]! >= threshold + START_ABOVE_DB - margin && level[f]! >= loudest[f]! - BLEED_DB - margin;
      active[f] = on ? 1 : 0;
    }
    for (const [from, to] of dropShort(bridge(runs(active)))) {
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
  const hops = Math.round(TURN_FRAME_S / ENERGY_HOP_S);
  const shift = Math.round(input.offset / ENERGY_HOP_S);
  for (let f = 0; f < frames; f++) {
    const first = f * hops - shift;
    let max = Number.NEGATIVE_INFINITY;
    for (let h = Math.max(0, first); h < Math.min(db.length, first + hops); h++) if (db[h]! > max) max = db[h]!;
    out[f] = max;
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

function bridge(list: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const run of list) {
    const last = out.at(-1);
    if (last && (run[0] - last[1]) * TURN_FRAME_S <= MERGE_GAP_S + 1e-9) last[1] = run[1];
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
