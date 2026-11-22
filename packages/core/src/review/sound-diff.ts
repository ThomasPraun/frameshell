import type { HistorySoundRange, HistorySoundTrack } from "@frameshell/protocol";
import { RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { BINARY_ERRORS } from "../media/duck.js";
import { ENERGY_HOP_S, type EnergyProfile, SILENCE_DB } from "../media/energy.js";
import { type HeardClip, heardClips, levelAt } from "./sound.js";
import { SOUND_DIFF_DB, SOUND_DIFF_FLOOR_DBFS, SOUND_DIFF_GAP_S, SOUND_DIFF_LISTED, SOUND_DIFF_MIN_S } from "./thresholds.js";

// What a transaction did to the sound, per track (`history.sound`, #803). Pure: the heard clips of the timeline before
// and after it in, changed ranges out. Like the sound review, nothing is mixed: each clip is heard from its asset's
// 10 ms envelope with its gain and fades (`levelAt`), and the clips of one track are summed in power.

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const toDb = (power: number) => (power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB);

/** Level in dBFS of each track, one value per {@link ENERGY_HOP_S} from timeline second 0 to `end`. */
export function trackLevels(clips: readonly HeardClip[], profiles: ReadonlyMap<string, EnergyProfile>, end: number): Map<string, Float64Array> {
  const hops = Math.max(0, Math.ceil(end / ENERGY_HOP_S - 1e-9));
  const power = new Map<string, Float64Array>();
  for (const clip of clips) {
    const profile = profiles.get(clip.asset);
    let series = power.get(clip.track);
    if (!series) power.set(clip.track, (series = new Float64Array(hops)));
    if (!profile) continue;
    const from = Math.max(0, Math.floor(clip.start / ENERGY_HOP_S + 1e-9));
    const to = Math.min(hops, Math.ceil(clip.end / ENERGY_HOP_S - 1e-9));
    for (let i = from; i < to; i++) {
      const level = levelAt(clip, profile, (i + 0.5) * ENERGY_HOP_S);
      if (level !== null) series[i]! += 10 ** (level / 10);
    }
  }
  const levels = new Map<string, Float64Array>();
  for (const [track, series] of power) levels.set(track, series.map(toDb));
  return levels;
}

/** Display name of each sound track of `timeline`; a program's sound track (`<track>/<inner>`) is named after its host. */
export function trackNames(timeline: Timeline, ids: Iterable<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const id of ids) {
    const [host, ...inner] = id.split("/");
    const track = timeline.tracks.find((candidate) => candidate.id === host);
    const name = track?.name ?? host!;
    names.set(id, inner.length > 0 ? `${name}/${inner.join("/")}` : name);
  }
  return names;
}

/**
 * Tracks whose sound differs between `before` and `after`, each with the ranges where it does, in timeline seconds.
 * A hop counts when the level moved {@link SOUND_DIFF_DB} or more and the track is heard there on at least one side
 * (louder than {@link SOUND_DIFF_FLOOR_DBFS}). `kind` says whether the sound came in (`added`: silent before), went
 * (`removed`: silent after) or changed level (`level`). `change` is the median move in dB, `largest` the biggest.
 * Tracks without a changed range are left out; `unchanged` lists them.
 */
export function soundDiff(
  before: ReadonlyMap<string, Float64Array>,
  after: ReadonlyMap<string, Float64Array>,
  names: ReadonlyMap<string, string>,
): { tracks: HistorySoundTrack[]; unchanged: string[] } {
  const tracks: HistorySoundTrack[] = [];
  const unchanged: string[] = [];
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const id of ids) {
    const a = before.get(id);
    const b = after.get(id);
    const hops = Math.max(a?.length ?? 0, b?.length ?? 0);
    const levelOf = (series: Float64Array | undefined, i: number) => (series && i < series.length ? series[i]! : SILENCE_DB);
    const ranges: HistorySoundRange[] = [];
    let open: { from: number; to: number; moves: number[]; before: number[]; after: number[] } | null = null;
    const close = () => {
      if (open && (open.to - open.from) * ENERGY_HOP_S >= SOUND_DIFF_MIN_S - 1e-9) ranges.push(rangeOf(open));
      open = null;
    };
    for (let i = 0; i < hops; i++) {
      const was = levelOf(a, i);
      const is = levelOf(b, i);
      const heard = was > SOUND_DIFF_FLOOR_DBFS || is > SOUND_DIFF_FLOOR_DBFS;
      if (!heard || Math.abs(is - was) < SOUND_DIFF_DB) continue;
      if (open && (i - open.to) * ENERGY_HOP_S > SOUND_DIFF_GAP_S + 1e-9) close();
      open ??= { from: i, to: i, moves: [], before: [], after: [] };
      open.to = i + 1;
      open.moves.push(Math.max(is, SOUND_DIFF_FLOOR_DBFS) - Math.max(was, SOUND_DIFF_FLOOR_DBFS));
      open.before.push(was);
      open.after.push(is);
    }
    close();
    if (ranges.length === 0) {
      if (a || b) unchanged.push(id);
      continue;
    }
    tracks.push({ track: id, name: names.get(id) ?? id, ranges: ranges.slice(0, SOUND_DIFF_LISTED), more: Math.max(0, ranges.length - SOUND_DIFF_LISTED) });
  }
  return { tracks, unchanged };
}

function rangeOf(open: { from: number; to: number; moves: number[]; before: number[]; after: number[] }): HistorySoundRange {
  const silent = (levels: number[]) => levels.every((level) => level <= SOUND_DIFF_FLOOR_DBFS);
  const kind = silent(open.before) ? "added" : silent(open.after) ? "removed" : "level";
  const sorted = [...open.moves].sort((x, y) => x - y);
  const largest = open.moves.reduce((best, move) => (Math.abs(move) > Math.abs(best) ? move : best), 0);
  return {
    from: round(open.from * ENERGY_HOP_S),
    to: round(open.to * ENERGY_HOP_S),
    kind,
    change: round(sorted[Math.floor(sorted.length / 2)]!, 1),
    largest: round(largest, 1),
  };
}

/** What {@link compareSound} reads. */
export interface CompareSoundInput {
  /** The flattened timeline right before the target and right after it. */
  before: Timeline;
  after: Timeline;
  fps: number;
  /** The 10 ms envelope of a project asset (`EnergyStore.profile`). */
  profile(asset: string): Promise<EnergyProfile>;
  signal?: AbortSignal | undefined;
}

/**
 * The sound difference of the two timelines (`history.sound`). Every clip with sound counts, whatever its role: every
 * asset is passed to `heardClips` as transcribed, so footage on video tracks is heard too. An asset that cannot be
 * decoded is left out on both sides and listed in `unheard`; a missing ffmpeg throws.
 */
export async function compareSound(input: CompareSoundInput): Promise<{ tracks: HistorySoundTrack[]; unchanged: string[]; unheard: string[] }> {
  const heard = (timeline: Timeline) => {
    const assets = new Set(timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [] : track.clips.flatMap((clip) => ("asset" in clip ? [clip.asset] : [])))));
    return heardClips(timeline, input.fps, { transcribed: assets, kinds: new Map() });
  };
  const before = heard(input.before);
  const after = heard(input.after);
  const profiles = new Map<string, EnergyProfile>();
  const unheard: string[] = [];
  for (const asset of new Set([...before, ...after].map((clip) => clip.asset))) {
    input.signal?.throwIfAborted();
    try {
      profiles.set(asset, await input.profile(asset));
    } catch (error) {
      if (error instanceof RpcError && BINARY_ERRORS.includes(error.code)) throw error;
      unheard.push(asset);
    }
  }
  const end = Math.max(0, ...[...before, ...after].map((clip) => clip.end));
  const levelsBefore = trackLevels(before, profiles, end);
  const levelsAfter = trackLevels(after, profiles, end);
  const names = trackNames(input.after, [...levelsBefore.keys(), ...levelsAfter.keys()]);
  for (const [id, name] of trackNames(input.before, levelsBefore.keys())) if (!levelsAfter.has(id)) names.set(id, name);
  return { ...soundDiff(levelsBefore, levelsAfter, names), unheard: unheard.sort() };
}
