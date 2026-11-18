// `voiceover.place` (ADR 0034 decision 19): the takes of a voiceover script → phrases (`splitPhrases`) → whole frames →
// one phrase clip each on an audio track. Planning is separate from the transaction so the daemon opens it only once
// there is something to write. Times come from the shared TimeRef resolver (`deps.resolve`); nothing here parses a ref.
import { ErrorCode, RpcError, type ValidatedParams, type VoiceoverPlaceResult } from "@frameshell/protocol";
import { type Timeline, type Track, VOICEOVER_TEMPO_RANGE, clipLength } from "@frameshell/schema";
import type { StepResult } from "../sound/place.js";
import { FrameGrid } from "../timeline/grid.js";
import { TimeRefError } from "../timeline/time-ref.js";
import { invalidParam, pickLines, readVoiceoverScript } from "./script.js";
import { PHRASE_FADE_S } from "./split.js";
import { readLineTakes } from "./takes.js";

/** Params of `voiceover.place`. */
export type VoiceoverPlaceParams = ValidatedParams<"voiceover.place">;

/** Milliseconds of the sample-accurate sound fade at both ends of every phrase clip (`audio.fadeInMs`/`fadeOutMs`). */
export const PHRASE_FADE_MS = Math.round(PHRASE_FADE_S * 1000);

/** Name of the audio track the voice goes on, made when absent. */
export const VOICE_TRACK_NAME = "Voiceover";

type Anchor = VoiceoverPlaceResult["placed"][number]["anchor"];

/** The timeline a plan reads, as `timelines.viewTimeline` gives it. */
export interface LoadedTimeline {
  timeline: Timeline;
  fps: number;
}

/** What planning needs of the daemon. */
export interface PlaceDeps {
  root: string;
  load(): Promise<LoadedTimeline>;
  /**
   * Seconds a time reference names on `loaded`'s timeline, in any form the protocol's `TimeRef` describes; throws
   * `TimeRefError`.
   */
  resolve(ref: number | string, loaded: LoadedTimeline): Promise<number>;
}

/** One phrase clip to add. */
export interface PlannedClip {
  line: string;
  /** Phrase number inside the line, from 1. */
  phrase: number;
  file: string;
  in: number;
  out: number;
  start: number;
  end: number;
  /** Clip `speed`: the phrase's tempo, 1 = as spoken. */
  speed: number;
  /** Seconds the clip lasts on the timeline, `(out - in) / speed` to the millisecond. */
  duration: number;
  anchor: Anchor;
  scriptRef: string;
}

/** What the transaction will do; {@link runVoiceoverPlan} writes it. */
export interface VoiceoverPlan {
  timeline: string;
  revision: number;
  /** Transaction label. */
  label: string;
  script: string;
  track: VoiceoverPlaceResult["track"];
  /** Clips to remove first (`replace`). */
  remove: string[];
  clips: PlannedClip[];
  lines: VoiceoverPlaceResult["lines"];
  warnings: string[];
}

function invalid(field: string, message: string, extra: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `voiceover.place: ${field}: ${message}`, { op: "voiceover.place", reason: message, field, ...extra });
}

/** Seconds `ref` names, with a time-reference failure turned into `InvalidOperation` that names the argument. */
async function resolveAt(deps: PlaceDeps, loaded: LoadedTimeline, ref: number | string, field: string): Promise<number> {
  try {
    return await deps.resolve(ref, loaded);
  } catch (error) {
    if (!(error instanceof TimeRefError)) throw error;
    throw invalid(field, error.message, { value: ref, ...(error.hint ? { hint: error.hint } : {}) });
  }
}

/**
 * The values of a per-phrase argument (`at`, `tempo`) as `line id` → phrase number (from 1) → value. A key is a line id
 * (the same as its phrase 1) or `<line id>.<phrase>`.
 */
function phraseKeys<T>(
  argument: "at" | "tempo",
  given: Record<string, T>,
  lines: readonly { id: string }[],
  phraseCounts: ReadonlyMap<string, number>,
): Map<string, Map<number, T>> {
  const found = new Map<string, Map<number, T>>();
  for (const [key, ref] of Object.entries(given)) {
    const dot = key.lastIndexOf(".");
    const tail = dot < 0 ? null : key.slice(dot + 1);
    const phrased = tail !== null && /^[1-9]\d*$/.test(tail);
    const id = phrased ? key.slice(0, dot) : key;
    const phrase = phrased ? Number(tail) : 1;
    const count = phraseCounts.get(id);
    if (count === undefined) {
      throw invalidParam(argument, `\`${argument}\` names ${key}, which is not a line of this call (lines: ${lines.map((line) => line.id).join(", ")}).`);
    }
    if (phrase > count) {
      throw invalidParam(argument, `\`${argument}\` names phrase ${phrase} of ${id}, which has ${count} phrase${count === 1 ? "" : "s"}.`);
    }
    const own = found.get(id) ?? new Map<number, T>();
    if (own.has(phrase)) throw invalidParam(argument, `\`${argument}\` gives ${id} phrase ${phrase} twice (\`${id}\` is the same as \`${id}.1\`).`);
    own.set(phrase, ref);
    found.set(id, own);
  }
  return found;
}

/** Frames `[start, end)` the clips of `track` occupy, by clip id, leaving out `removed`. */
function occupied(track: Track | undefined, grid: FrameGrid, removed: ReadonlySet<string>): { id: string; start: number; end: number }[] {
  if (track?.kind !== "audio") return [];
  return track.clips
    .filter((clip) => !removed.has(clip.id))
    .map((clip) => {
      const length = clipLength(clip, { fps: grid.fps });
      const start = grid.frame(clip.start);
      return { id: clip.id, start, end: Number.isFinite(length) ? start + grid.frame(length) : Number.POSITIVE_INFINITY };
    });
}

/**
 * End frame of a phrase as the engine's `clipEnd` counts it: from the stored 3-decimal seconds, snapped to the grid,
 * at least one frame. Rounding frames directly differs by one frame at some tempos.
 */
export function phraseEnd(grid: FrameGrid, start: number, inFrame: number, outFrame: number, speed: number): number {
  const length = (grid.seconds(outFrame) - grid.seconds(inFrame)) / speed;
  return Math.max(start + 1, grid.frame(grid.seconds(start) + length));
}

/**
 * Plan the call: read the script and the takes of its lines, split each take into phrases, find where each goes (given
 * by `at`, after the previous one, or at the track's end) and fit them on whole frames. Writes nothing. Throws
 * `ScriptNotFound`, `InvalidParams` (unknown line or `at` key) or `InvalidOperation` (no take, an unknown marker, overlap,
 * clips already placed, a `track` that is not an audio track).
 */
export async function planVoiceoverPlacement(params: VoiceoverPlaceParams, deps: PlaceDeps): Promise<VoiceoverPlan> {
  const read = await readVoiceoverScript(deps.root, params.cwd, params.script, "voiceover.place");
  const lines = pickLines(read.lines, params.lines);
  const { takes: spoken, warnings } = await readLineTakes(deps.root, read.path, lines, "voiceover.place");
  const phraseCounts = new Map(spoken.map((entry) => [entry.line.id, entry.phrases.length] as const));
  const anchors = params.at ? phraseKeys("at", params.at, lines, phraseCounts) : new Map<string, Map<number, number | string>>();
  for (const [key, value] of Object.entries(params.tempo ?? {})) {
    // The schema bounds it; the check keeps a direct caller of the planner (tests, other code) to the same range.
    if (!(value >= VOICEOVER_TEMPO_RANGE.min && value <= VOICEOVER_TEMPO_RANGE.max)) {
      throw invalidParam("tempo", `\`tempo\` gives ${key} ${value}; a phrase's tempo is ${VOICEOVER_TEMPO_RANGE.min} to ${VOICEOVER_TEMPO_RANGE.max} (1 = as spoken).`);
    }
  }
  const tempos = params.tempo ? phraseKeys("tempo", params.tempo, lines, phraseCounts) : new Map<string, Map<number, number>>();

  const loaded = await deps.load();
  const { timeline, fps } = loaded;
  const grid = new FrameGrid(fps);

  let main: Track | undefined;
  if (params.track !== undefined) {
    main = timeline.tracks.find((candidate) => candidate.id === params.track);
    if (!main) throw invalid("track", `no track "${params.track}" in timeline ${timeline.id}.`, { available: timeline.tracks.map((candidate) => candidate.id) });
    if (main.kind !== "audio") throw invalid("track", `${main.id} is a ${main.kind} track; the voice goes on an audio track.`);
  } else {
    main = timeline.tracks.find((candidate) => candidate.kind === "audio" && candidate.name?.toLowerCase() === VOICE_TRACK_NAME.toLowerCase());
  }

  // Clips that already play these takes, on any track: placed again only with `replace`.
  const files = new Set(spoken.map((entry) => entry.file));
  const already: { id: string; track: string; file: string }[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) if ("asset" in clip && files.has(clip.asset)) already.push({ id: clip.id, track: track.id, file: clip.asset });
  }
  if (already.length > 0 && !params.replace) {
    throw invalid("replace", `clips already play these takes: ${already.map((use) => `${use.id} (${use.file})`).join(", ")}. Pass \`replace\` to remove them and place the phrases again.`, {
      clips: already.map((use) => use.id),
      hint: "Use `replace` after the takes changed, or `lines` to place only the lines that are not on the timeline yet.",
    });
  }
  const remove = already.map((use) => use.id);
  const busy = occupied(main, grid, new Set(remove));

  const startRef = params.start;
  const startFrame =
    startRef !== undefined
      ? grid.frame(await resolveAt(deps, loaded, startRef, "start"))
      : busy.reduce((end, clip) => Math.max(end, Number.isFinite(clip.end) ? clip.end : clip.start), 0);
  const gapFrames = Math.round(params.gap * fps);

  const clips: PlannedClip[] = [];
  const placed: VoiceoverPlan["lines"] = [];
  // Where the last planned phrase ends in the take, and where it starts and ends on the timeline: the next one follows or must not cross it.
  let last: { line: string; phrase: number; outFrame: number; start: number; end: number } | null = null;

  for (const { line, file, duration, phrases } of spoken) {
    const own = anchors.get(line.id);
    const scriptRef = `${read.path}#${line.scene}`;
    const maxFrame = grid.frame(grid.floor(duration));
    const firstOfLine = clips.length;
    for (const [index, phrase] of phrases.entries()) {
      const number = index + 1;
      const inFrame = grid.frame(phrase.from);
      const outFrame = Math.min(grid.frame(phrase.to), maxFrame);
      if (outFrame <= inFrame) {
        warnings.push(`Line ${line.id}, phrase ${number} (${phrase.from} to ${phrase.to} s of the take) is shorter than one frame at ${fps} fps and is left out.`);
        continue;
      }
      const ref = own?.get(number);
      let start: number;
      let anchor: Anchor;
      if (ref !== undefined) {
        start = grid.frame(await resolveAt(deps, loaded, ref, `at.${number === 1 ? line.id : `${line.id}.${number}`}`));
        anchor = "at";
      } else if (clips.length === firstOfLine) {
        start = last === null ? startFrame : last.end + gapFrames;
        anchor = last === null ? "start" : "follows";
      } else {
        // The pause the take has between the two phrases keeps its length, at whatever tempo the phrase before it plays.
        start = last!.end + (inFrame - last!.outFrame);
        anchor = "spacing";
      }
      const speed = tempos.get(line.id)?.get(number) ?? 1;
      const end = phraseEnd(grid, start, inFrame, outFrame, speed);
      if (last && start < last.end) {
        throw invalid(
          `at.${number === 1 ? line.id : `${line.id}.${number}`}`,
          `${line.id} phrase ${number} would start at ${grid.seconds(start)} s, before ${last.line} phrase ${last.phrase} ends at ${grid.seconds(last.end)} s: the voice would overlap itself (phrases are placed in script order, so anchors must run in that order).`,
          { hint: "Anchor lines in script order (each `at` after the one before it), or leave an `at` out so the phrase follows the previous one." },
        );
      }
      const clash = busy.find((other) => start < other.end && other.start < end);
      if (clash) {
        throw invalid(
          "start",
          `${line.id} phrase ${number} (${grid.seconds(start)} to ${grid.seconds(end)} s) would overlap clip ${clash.id}, which is already on the voice track.`,
          { clip: clash.id, hint: "Pass `start` or `at` after it, or another `track`." },
        );
      }
      clips.push({
        line: line.id,
        phrase: number,
        file,
        in: grid.seconds(inFrame),
        out: grid.seconds(outFrame),
        start: grid.seconds(start),
        end: grid.seconds(end),
        speed,
        duration: Math.round(((outFrame - inFrame) / fps / speed) * 1000) / 1000,
        anchor,
        scriptRef,
      });
      last = { line: line.id, phrase: number, outFrame, start, end };
    }
    if (clips.length === firstOfLine) {
      warnings.push(`Line ${line.id} has no phrase of a frame or more: nothing is placed for it.`);
      continue;
    }
    const mine = clips.slice(firstOfLine);
    placed.push({ id: line.id, start: mine[0]!.start, end: mine.at(-1)!.end, anchor: mine[0]!.anchor === "spacing" ? "follows" : mine[0]!.anchor });
  }

  return {
    timeline: timeline.id,
    revision: timeline.revision,
    label: labelOf(read.path, placed.length),
    script: read.path,
    track: { id: main?.id ?? null, name: main ? (main.name ?? main.id) : VOICE_TRACK_NAME, created: main === undefined },
    remove,
    clips,
    lines: placed,
    warnings,
  };
}

function labelOf(script: string, lines: number): string {
  const name = script.split("/").at(-1)!.replace(/\.md$/i, "");
  return `Voiceover: ${name}${lines === 1 ? "" : ` (${lines} lines)`}`;
}

/** One operation of the transaction. */
export type VoiceoverStep =
  | { op: "clip.remove"; args: { clip: string } }
  | { op: "track.add"; args: { kind: "audio"; name: string } }
  | {
      op: "clip.add";
      args: { track: string; type: "media"; asset: string; start: number; in: number; out: number; speed?: number; scriptRef: string; audioFadeInMs: number; audioFadeOutMs: number };
    };

/** What writing a plan produced: the parts of the result that only a write knows. */
export type VoiceoverWritten = Pick<VoiceoverPlaceResult, "revision" | "warnings"> & { track: string; clipIds: string[] };

/**
 * Write `plan` with `apply`, one step at a time: the old clips out, the track in when it is missing, then a clip per
 * phrase with {@link PHRASE_FADE_MS} fades at both ends.
 */
export async function runVoiceoverPlan(plan: VoiceoverPlan, apply: (step: VoiceoverStep) => Promise<StepResult>): Promise<VoiceoverWritten> {
  const warnings: string[] = [];
  let revision = plan.revision;
  const note = (done: StepResult) => {
    revision = done.revision;
    warnings.push(...done.warnings);
  };
  for (const clip of plan.remove) note(await apply({ op: "clip.remove", args: { clip } }));
  let track = plan.track.id;
  if (track === null) {
    const done = await apply({ op: "track.add", args: { kind: "audio", name: plan.track.name ?? VOICE_TRACK_NAME } });
    note(done);
    track = done.added[0] ?? null;
    if (track === null) throw new Error("voiceover.place: track.add reported no new track");
  }
  const clipIds: string[] = [];
  for (const clip of plan.clips) {
    const done = await apply({
      op: "clip.add",
      args: {
        track,
        type: "media",
        asset: clip.file,
        start: clip.start,
        in: clip.in,
        out: clip.out,
        ...(clip.speed !== 1 ? { speed: clip.speed } : {}),
        scriptRef: clip.scriptRef,
        audioFadeInMs: PHRASE_FADE_MS,
        audioFadeOutMs: PHRASE_FADE_MS,
      },
    });
    note(done);
    clipIds.push(done.added[0] ?? "");
  }
  return { revision, warnings, track, clipIds };
}
