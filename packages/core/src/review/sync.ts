import type { ReviewCraftWarning, ReviewSync } from "@frameshell/protocol";
import {
  SYNC_CHANCE_MARGIN,
  SYNC_CHANCE_SHIFTS_S,
  SYNC_EARLY_S,
  SYNC_LATE_S,
  SYNC_LISTED,
  SYNC_LISTED_CUTS,
  SYNC_MATCH_S,
  SYNC_MIN_SOUNDS,
  SYNC_NEAR_S,
} from "./thresholds.js";

// Sounds against the picture events they belong to (#457). Pure: onsets and events in, the verdicts and a chance baseline out.
// A sound landing on every cut proves nothing, so the hit rate is set beside what the same sounds score moved by fixed
// offsets, and what is left over is listed: cuts with no sound, sounds with no picture event.

/** A sound's start: its onset in a file, or the anchor of a generated take. */
export interface Onset {
  /** Seconds. */
  at: number;
  /** Generated effect kind; null for a hit found in a file. */
  kind: string | null;
}

/** Effects that do not land on an event by design: a whoosh peaks before it, a riser builds to it, ticks keep time. */
export const SYNC_EXCLUDED_KINDS: readonly string[] = ["whoosh", "riser", "tick"];

/** What {@link syncMetrics} reads. */
export interface SyncInput {
  source: ReviewSync["source"];
  sounds: readonly Onset[];
  /** Seconds of the visual events of the picture (`visualEvents`). */
  events: readonly number[];
  /** Seconds of the cuts of the timeline; empty for a file. */
  cuts: readonly number[];
  range: { from: number; to: number };
  /** Seconds between the samples the events were found on. */
  spacing: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The event nearest to `at` within `reach` seconds, or null. */
function nearest(events: readonly number[], at: number, reach: number): number | null {
  let best: number | null = null;
  for (const event of events) if (Math.abs(event - at) <= reach && (best === null || Math.abs(event - at) < Math.abs(best - at))) best = event;
  return best;
}

/** The sync of `input`; null when the range holds no sound at all. */
export function syncMetrics(input: SyncInput): ReviewSync | null {
  const { range, events } = input;
  const inside = input.sounds.filter((sound) => sound.at >= range.from && sound.at < range.to);
  if (inside.length === 0) return null;
  const scored = inside.filter((sound) => sound.kind === null || !SYNC_EXCLUDED_KINDS.includes(sound.kind));
  // An event is found between two samples: the finest offset that can be told is half the spacing.
  const slack = input.spacing / 2;
  const offsets = scored.map((sound): ReviewSync["offsets"][number] => {
    const picture = nearest(events, sound.at, SYNC_MATCH_S + slack);
    if (picture === null) return { at: round(sound.at), kind: sound.kind, picture: null, offset: null, verdict: "none" };
    const offset = sound.at - picture;
    const verdict = offset < -(SYNC_EARLY_S + slack) ? "early" : offset > SYNC_LATE_S + slack ? "late" : "on";
    return { at: round(sound.at), kind: sound.kind, picture: round(picture), offset: round(offset), verdict };
  });
  const hits = offsets.filter((entry) => entry.offset !== null && Math.abs(entry.offset) <= SYNC_EARLY_S + slack).length;

  const nearShare = (shift: number): { near: number; total: number } => {
    let near = 0;
    let total = 0;
    for (const sound of scored) {
      const at = sound.at + shift;
      if (at < range.from || at >= range.to) continue;
      total++;
      if (nearest(events, at, SYNC_NEAR_S + slack) !== null) near++;
    }
    return { near, total };
  };
  const observed = nearShare(0);
  let near = 0;
  let total = 0;
  for (const shift of SYNC_CHANCE_SHIFTS_S) {
    const shifted = nearShare(shift);
    near += shifted.near;
    total += shifted.total;
  }
  const silentCuts = [...new Set(input.cuts.map(round))]
    .filter((cut) => cut > range.from && cut < range.to && nearest(inside.map((sound) => sound.at), cut, SYNC_MATCH_S) === null)
    .slice(0, SYNC_LISTED_CUTS);
  return {
    source: input.source,
    sounds: scored.length,
    excluded: inside.length - scored.length,
    spacing: round(input.spacing),
    hits,
    near: observed.total > 0 ? round(observed.near / observed.total) : null,
    chance: total > 0 ? round(near / total) : null,
    offsets: offsets.slice(0, SYNC_LISTED),
    silentCuts,
  };
}

/** Craft warnings of a sync: sounds early or late, and sounds no nearer a picture event than random ones. */
export function syncWarnings(sync: ReviewSync): ReviewCraftWarning[] {
  const warnings: ReviewCraftWarning[] = [];
  for (const verdict of ["early", "late"] as const) {
    const found = sync.offsets.filter((entry) => entry.verdict === verdict);
    if (found.length === 0) continue;
    const limit = verdict === "early" ? SYNC_EARLY_S : SYNC_LATE_S;
    const list = found.slice(0, 4).map((entry) => `${entry.at} s (${Math.round(entry.offset! * 1000)} ms)`);
    warnings.push({
      check: "sync",
      from: found[0]!.at,
      to: found.at(-1)!.at,
      message:
        `${found.length} ${found.length === 1 ? "sound lands" : "sounds land"} more than ${Math.round(limit * 1000)} ms ${verdict === "early" ? "before" : "after"} the picture event ${found.length === 1 ? "it belongs" : "they belong"} to: ` +
        `${list.join(", ")}${found.length > list.length ? ", ..." : ""}. ${verdict === "early" ? "Move the sound later" : "Move the sound earlier"}; round placement so a sound is never before its picture.`,
    });
  }
  if (sync.sounds >= SYNC_MIN_SOUNDS && sync.near !== null && sync.chance !== null && sync.near - sync.chance < SYNC_CHANCE_MARGIN) {
    warnings.push({
      check: "sync",
      from: null,
      to: null,
      message:
        `the sounds sit near a picture event (within 0.1 s) ${Math.round(sync.near * 100)} % of the time, and the same sounds moved by fixed offsets ${Math.round(sync.chance * 100)} %: ` +
        "that is what random placement scores. Put a sound where something physical happens, and list cuts with no sound and sounds with no picture event instead of scoring every cut.",
    });
  }
  return warnings;
}
