import type { Timeline } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile } from "./energy.js";

/** Shortest stretch kept as speech: clicks and chair noise are shorter. */
const MIN_SPEECH_S = 0.1;

/** A stretch of time, seconds. */
export interface Span {
  start: number;
  end: number;
}

/** One point of a dip curve: `dip` dB below full level at timeline second `time`. */
export interface DipPoint {
  time: number;
  dip: number;
}

/** Runs of an envelope (one dBFS value per {@link ENERGY_HOP_S}) at or above `threshold`, in the envelope's own seconds. */
export function loudSpans(db: Float32Array, threshold: number): Span[] {
  const spans: Span[] = [];
  let from = -1;
  for (let i = 0; i <= db.length; i++) {
    const loud = i < db.length && db[i]! >= threshold;
    if (loud && from < 0) from = i;
    if (!loud && from >= 0) {
      spans.push({ start: from * ENERGY_HOP_S, end: i * ENERGY_HOP_S });
      from = -1;
    }
  }
  return spans;
}

/** The part of `spans` (source seconds) inside source window [`from`, `to`), laid on the timeline: source second `from` plays at `start`, `speed` times faster. */
export function spansOnTimeline(spans: readonly Span[], window: { from: number; to: number; start: number; speed: number }): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const a = Math.max(span.start, window.from);
    const b = Math.min(span.end, window.to);
    if (b > a) out.push({ start: window.start + (a - window.from) / window.speed, end: window.start + (b - window.from) / window.speed });
  }
  return out;
}

/**
 * Speech stretches from the loud runs of every voice clip on the timeline: sorted, merged where closer than `gap`, and
 * stretches shorter than {@link MIN_SPEECH_S} dropped. The dip needs `attack + release` seconds of room, so a gap
 * shorter than that merges too: the music stays down instead of pumping between two words.
 */
export function speechStretches(runs: readonly Span[], options: { gap: number; attack: number; release: number }): Span[] {
  const room = Math.max(options.gap, options.attack + options.release);
  const merged: Span[] = [];
  for (const run of [...runs].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && run.start - last.end < room) last.end = Math.max(last.end, run.end);
    else merged.push({ ...run });
  }
  return merged.filter((span) => span.end - span.start >= MIN_SPEECH_S);
}

/**
 * Dip over time for `stretches`: full depth from the stretch start (reached over `attack` seconds before it) to its
 * end, back to nothing `release` seconds later. Stretches are at least `attack + release` apart ({@link speechStretches}),
 * so the points are sorted. A stretch that starts inside the first `attack` seconds begins its ramp part way down.
 */
export function dipCurve(stretches: readonly Span[], options: { depth: number; attack: number; release: number }): DipPoint[] {
  const points: DipPoint[] = [];
  for (const { start, end } of stretches) {
    const from = start - options.attack;
    points.push(
      from < 0 ? { time: 0, dip: (options.depth * -from) / options.attack } : { time: from, dip: 0 },
      { time: start, dip: options.depth },
      { time: end, dip: options.depth },
      { time: end + options.release, dip: 0 },
    );
  }
  return points.map((point) => ({ time: Math.round(point.time * 1000) / 1000, dip: Math.round(point.dip * 10000) / 10000 }));
}

/** Dip in dB at `time` on a curve of straight lines between sorted `points`; 0 before the first and after the last. */
export function dipAt(points: readonly DipPoint[], time: number): number {
  const first = points[0];
  if (!first || time < first.time) return 0;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (time > b.time) continue;
    const a = points[i - 1]!;
    return b.time === a.time ? b.dip : a.dip + ((b.dip - a.dip) * (time - a.time)) / (b.time - a.time);
  }
  return 0;
}

/**
 * Loud runs of the sound of the media clips on the `under` tracks of `timeline`, on the timeline clock. Muted tracks
 * and clips are not listened to; assets that cannot be decoded (a still image) and clips that carry no media
 * (nested timelines, generated pictures) are named in `warnings`.
 */
export async function voiceRuns(
  timeline: Timeline,
  under: readonly string[],
  options: { threshold: number; profile(asset: string): Promise<EnergyProfile> },
): Promise<{ runs: Span[]; warnings: string[] }> {
  const runs: Span[] = [];
  const warnings: string[] = [];
  const loud = new Map<string, Promise<Span[] | null>>();
  for (const id of under) {
    const track = timeline.tracks.find((candidate) => candidate.id === id);
    if (!track || (track.kind !== "video" && track.kind !== "audio") || track.muted === true) continue;
    for (const clip of track.clips) {
      if (clip.audio?.muted === true) continue;
      if (!("asset" in clip)) {
        if (clip.type === "timeline") warnings.push(`${clip.id} on ${id} is a nested timeline: its speech is not heard, so the music does not duck under it.`);
        continue;
      }
      let spans = loud.get(clip.asset);
      if (!spans) {
        spans = options.profile(clip.asset).then(
          (profile) => loudSpans(profile.db, options.threshold),
          () => null,
        );
        loud.set(clip.asset, spans);
      }
      const found = await spans;
      if (!found) continue;
      runs.push(...spansOnTimeline(found, { from: clip.in, to: clip.out, start: clip.start, speed: clip.speed ?? 1 }));
    }
  }
  return { runs, warnings };
}
