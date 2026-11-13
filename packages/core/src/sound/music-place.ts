// `sound.music` (ADR 0038 slice 3): times → bars, sections and accents → the spec → the take (and its beat grid) →
// where the clip goes. Planning touches no timeline file, so the daemon opens the transaction only to place it.
import { ErrorCode, type OperationResult, RpcError, type SoundMusicResult, type ValidatedParams } from "@frameshell/protocol";
import { MUSIC_MAX_BARS, MUSIC_MAX_SECONDS, MUSIC_PRESET_DEFAULTS, type MusicSection, type Timeline, type Track } from "@frameshell/schema";
import { FrameGrid } from "../timeline/grid.js";
import { TimeRefError } from "../timeline/time-ref.js";
import { type MusicSpec, defaultSections } from "./music.js";
import type { MusicTake } from "./music-take.js";
import { occupied } from "./place.js";

/** Params of `sound.music`. */
export type MusicParams = ValidatedParams<"sound.music">;

/** Name of the audio track a music clip goes on; when its time is taken, `Music 2`, `Music 3`… */
export const MUSIC_TRACK_NAME = "Music";

/** What `planMusic` needs from the daemon. */
export interface MusicPlanDeps {
  /** The timeline as the caller sees it, with its frame rate. */
  load(): Promise<{ timeline: Timeline; fps: number }>;
  /** Seconds the timeline lasts as the caller sees it; null when unknown (a clip whose length cannot be read). */
  duration(): Promise<number | null>;
  /** Seconds a time reference names on `timeline`; throws `TimeRefError`. */
  resolve(ref: number | string, timeline: Timeline): number;
  /** Make (or reuse) the take; serialised with other sound work of the project by the caller. */
  take(spec: MusicSpec): Promise<MusicTake>;
  /** dB the style puts music under the voice. */
  musicUnderVoice(): Promise<number>;
}

/** Where the clip goes and what the transaction writes. */
export interface MusicPlacement {
  timeline: string;
  revision: number;
  /** Existing audio track, or null to make one named `name`. */
  track: { id: string | null; name: string };
  /** Timeline second of the clip, on the frame grid. */
  start: number;
  gain: number;
  /** `set`: the transaction also points the timeline's tempo at the new clip. */
  tempo: "set" | "kept";
  label: string;
}

/** What the call does: the take, and where it goes when it is placed. */
export interface MusicPlan {
  spec: MusicSpec;
  take: MusicTake;
  placement: MusicPlacement | null;
  warnings: string[];
}

function invalidParams(field: string, message: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, `sound.music: ${message}`, { issues: [{ path: [field], message }] });
}

function invalid(field: string, message: string, extra: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `sound.music: ${field}: ${message}`, { op: "sound.music", reason: message, field, ...extra });
}

/** One part as asked: its kind, its bars when given, the bar (from 0) its `at` lands on when given. */
export interface AskedSection {
  kind: MusicSection;
  bars?: number | undefined;
  startBar?: number | undefined;
}

/**
 * The parts of a track from what was asked: each starts at its `startBar`, or right after the part before (which then
 * needs `bars`); the last runs to `total`, or for its `bars` when `total` is null. Throws `InvalidParams` when the
 * parts overlap, leave a part empty, or disagree with `total`. Bars in messages count from 1, like `bar:N`.
 */
export function arrangeSections(total: number | null, asked: readonly AskedSection[]): { kind: MusicSection; bars: number }[] {
  const starts: number[] = [];
  asked.forEach((section, i) => {
    if (i === 0) {
      if (section.startBar !== undefined && section.startBar !== 0) throw invalidParams("sections", `the first part starts the track (bar 1); its \`at\` falls on bar ${section.startBar + 1}. Move \`at\` (the track's start) instead.`);
      starts.push(0);
      return;
    }
    const before = asked[i - 1]!;
    const start = section.startBar ?? (before.bars !== undefined ? starts[i - 1]! + before.bars : undefined);
    if (start === undefined) throw invalidParams("sections", `part ${i + 1} (${section.kind}) needs \`at\`, or the part before it needs \`bars\`.`);
    if (start <= starts[i - 1]!) throw invalidParams("sections", `part ${i + 1} (${section.kind}) starts on bar ${start + 1}, not after part ${i} (bar ${starts[i - 1]! + 1}).`);
    starts.push(start);
  });
  const last = asked.length - 1;
  const end = total ?? (asked[last]!.bars !== undefined ? starts[last]! + asked[last]!.bars! : null);
  if (end === null) throw invalidParams("sections", "give `bars` or `length`, or `bars` on the last part: nothing says where the track ends.");
  return asked.map((section, i) => {
    const next = i < last ? starts[i + 1]! : end;
    const bars = next - starts[i]!;
    if (bars < 1) throw invalidParams("sections", `part ${i + 1} (${section.kind}) would have no bars: the track has ${end} bar${end === 1 ? "" : "s"}.`);
    if (section.bars !== undefined && section.bars !== bars) {
      throw invalidParams("sections", `part ${i + 1} (${section.kind}) has \`bars\` ${section.bars}, but ${i < last ? `the next part starts on bar ${next + 1}` : `the track has ${end} bars`}: that leaves it ${bars}.`);
    }
    return { kind: section.kind, bars };
  });
}

/**
 * Plan the call: resolve the times, work out the bars, the parts and the accents, make the take (and its grid), and
 * when it is placed, the track, start, gain and tempo. Writes nothing to the timeline. Throws `StaleRevision` when the
 * timeline changed while the take was made.
 */
export async function planMusic(params: MusicParams, deps: MusicPlanDeps): Promise<MusicPlan> {
  const { preset, meter, place } = params;
  const bpm = params.bpm ?? MUSIC_PRESET_DEFAULTS[preset].bpm;
  const beat = 60 / bpm;
  const bar = beat * meter;
  if (params.bars !== undefined && params.length !== undefined) throw invalidParams("length", "give `bars` or `length`, not both.");
  const lastBars = params.sections?.[params.sections.length - 1]?.bars;
  const endKnown = params.bars !== undefined || params.length !== undefined || lastBars !== undefined;
  const refs = [params.at, ...(params.sections ?? []).map((section) => section.at), ...(params.accents ?? [])];
  const needsTimeline = place || !endKnown || refs.some((ref) => typeof ref === "string");
  const before = needsTimeline ? await deps.load() : null;
  const at = (ref: number | string, field: string) => {
    if (typeof ref === "number") return ref;
    try {
      return deps.resolve(ref, before!.timeline);
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw invalid(field, error.message, { value: ref, ...(error.hint ? { hint: error.hint } : {}) });
    }
  };
  const start = at(params.at, "at");

  let total: number | null = null;
  if (params.bars !== undefined) total = params.bars;
  else if (params.length !== undefined) total = Math.max(1, Math.round(params.length / bar));
  else if (lastBars === undefined) {
    const duration = await deps.duration();
    if (duration === null || duration - start < bar / 2) {
      throw invalidParams("bars", `nothing to go by for the length: the timeline ${duration === null ? "has no known length" : `ends at ${duration.toFixed(2)} s`}, from ${start.toFixed(2)} s that is under half a bar. Give \`bars\` or \`length\`.`);
    }
    total = Math.max(1, Math.round((duration - start) / bar));
  }

  const asked: AskedSection[] = (params.sections ?? []).map((section, i) => {
    if (section.at === undefined) return { kind: section.kind, bars: section.bars };
    const time = at(section.at, `sections[${i}].at`);
    if (time < start - bar / 2) throw invalid(`sections[${i}].at`, `${time.toFixed(3)} s is before the track starts (${start.toFixed(3)} s).`);
    return { kind: section.kind, bars: section.bars, startBar: Math.round((time - start) / bar) };
  });
  const sections = asked.length > 0 ? arrangeSections(total, asked) : defaultSections(total!);
  const bars = sections.reduce((sum, section) => sum + section.bars, 0);
  if (bars > MUSIC_MAX_BARS || bars * bar > MUSIC_MAX_SECONDS) {
    throw invalidParams("bars", `${bars} bars at ${bpm} BPM is ${Math.round(bars * bar)} s; a track is at most ${MUSIC_MAX_BARS} bars and ${MUSIC_MAX_SECONDS} s.`);
  }

  const accents = new Set<number>();
  (params.accents ?? []).forEach((ref, i) => {
    const time = at(ref, `accents[${i}]`);
    const index = Math.round((time - start) / beat);
    if (index < 0 || index > bars * meter) throw invalid(`accents[${i}]`, `${time.toFixed(3)} s is outside the track (${start.toFixed(3)} s to ${(start + bars * bar).toFixed(3)} s).`);
    accents.add(index);
  });
  const spec: MusicSpec = {
    preset,
    bpm,
    meter,
    sections,
    chords: params.chords ?? [...MUSIC_PRESET_DEFAULTS[preset].chords],
    seed: params.seed,
    accents: [...accents].sort((a, b) => a - b),
  };
  const take = await deps.take(spec);
  if (!place) return { spec, take, placement: null, warnings: [] };

  const { timeline, fps } = await deps.load();
  if (timeline.revision !== before!.timeline.revision) {
    throw new RpcError(ErrorCode.StaleRevision, `sound.music: timeline ${timeline.id} changed from revision ${before!.timeline.revision} to ${timeline.revision} while the track was made. Nothing was placed; run it again (the take is kept).`, {
      op: "sound.music",
      timeline: timeline.id,
      revision: before!.timeline.revision,
      current: timeline.revision,
    });
  }
  const grid = new FrameGrid(fps);
  const startFrame = grid.frame(start);
  // The engine keeps whole frames of a file; one spare frame keeps a rounding difference from making two clips touch.
  const end = startFrame + grid.frame(grid.floor(take.grid.duration)) + 1;
  const free = (track: Track) => !occupied(track, grid).some(([s, e]) => startFrame < e && s < end);
  let track: MusicPlacement["track"];
  if (params.track !== undefined) {
    const named = timeline.tracks.find((candidate) => candidate.id === params.track);
    if (!named) throw invalid("track", `no track "${params.track}" in timeline ${timeline.id}.`, { available: timeline.tracks.map((candidate) => candidate.id) });
    if (named.kind !== "audio") throw invalid("track", `${named.id} is a ${named.kind} track; music goes on an audio track.`);
    if (!free(named)) throw invalid("track", `${named.id} already has a clip between ${start.toFixed(2)} s and ${grid.seconds(end).toFixed(2)} s. Leave out \`track\` to get a free one, or move that clip.`);
    track = { id: named.id, name: named.name ?? named.id };
  } else {
    for (let n = 1; ; n++) {
      const name = n === 1 ? MUSIC_TRACK_NAME : `${MUSIC_TRACK_NAME} ${n}`;
      const found = timeline.tracks.find((candidate) => candidate.kind === "audio" && candidate.name?.toLowerCase() === name.toLowerCase());
      if (!found || free(found)) {
        track = { id: found?.id ?? null, name: found?.name ?? name };
        break;
      }
    }
  }
  const warnings: string[] = [];
  const tempo = timeline.tempo ? "kept" : "set";
  if (tempo === "kept") {
    const follows = timeline.tempo!.clip !== undefined ? `clip ${timeline.tempo!.clip}` : `a nominal ${timeline.tempo!.bpm} BPM`;
    warnings.push(`The timeline's tempo still follows ${follows}; to follow the new track: tempo set --clip <its clip id>.`);
  }
  const gain = params.gain ?? Math.round(-(await deps.musicUnderVoice()) * 10) / 10;
  return {
    spec,
    take,
    placement: { timeline: timeline.id, revision: timeline.revision, track, start: grid.seconds(startFrame), gain, tempo, label: `Music: ${preset} ${bpm} BPM, ${bars} bars` },
    warnings,
  };
}

/** One operation of the transaction. */
export type MusicStep =
  | { op: "track.add"; args: { kind: "audio"; name: string } }
  | { op: "clip.add"; args: { track: string; type: "media"; asset: string; start: number; gain: number } }
  | { op: "tempo.set"; args: { clip: string } };

/** Result of one applied step. */
export type MusicStepResult = Pick<OperationResult, "revision" | "warnings"> & { added: string[] };

/** Write `placement` with `apply`: the track when it is new, the clip, then the tempo. */
export async function runMusicPlacement(
  placement: MusicPlacement,
  file: string,
  apply: (step: MusicStep) => Promise<MusicStepResult>,
): Promise<{ revision: number; track: NonNullable<SoundMusicResult["track"]>; clip: string; warnings: string[] }> {
  const warnings: string[] = [];
  let id = placement.track.id;
  if (id === null) {
    const done = await apply({ op: "track.add", args: { kind: "audio", name: placement.track.name } });
    warnings.push(...done.warnings);
    id = done.added[0] ?? null;
    if (id === null) throw new Error("sound.music: track.add reported no new track");
  }
  const added = await apply({ op: "clip.add", args: { track: id, type: "media", asset: file, start: placement.start, gain: placement.gain } });
  warnings.push(...added.warnings);
  const clip = added.added[0];
  if (clip === undefined) throw new Error("sound.music: clip.add reported no new clip");
  let revision = added.revision;
  if (placement.tempo === "set") {
    const done = await apply({ op: "tempo.set", args: { clip } });
    warnings.push(...done.warnings);
    revision = done.revision;
  }
  return { revision, track: { id, name: placement.track.name, created: placement.track.id === null }, clip, warnings };
}
