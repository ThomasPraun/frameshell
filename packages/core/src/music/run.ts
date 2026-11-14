import { ErrorCode, MUSIC_FIT_MIN_CONFIDENCE, type MusicFitResult, RpcError } from "@frameshell/protocol";
import { type AnyClip, type ClipTrack, type DuckSettings, type MediaClip, type ShapeSettings, type Timeline, clipLength } from "@frameshell/schema";
import type { DipPoint } from "../media/duck.js";
import type { EnergyProfile } from "../media/energy.js";
import { FrameGrid } from "../timeline/grid.js";
import { type GridLoader, resolveTimeRefArg } from "../timeline/time-ref.js";
import { MUSIC_ENTRY_FADE_MS, needsEntryFade } from "./entry-fade.js";
import { type FitOperation, type FitPlan, clipEnd, planFit } from "./fit.js";
import { finalHit } from "./hit.js";
import { shapeCurve } from "./shape.js";

/** What `music.fit` needs from the project. */
export interface MusicFitDeps {
  /** The timeline's beat grid (`tempoGrid`), for `beat:` and `bar:` in `end` and `from`. */
  loadGrid: GridLoader;
  /** Energy envelope of a project-relative asset; throws when it cannot be decoded. */
  profile(asset: string): Promise<EnergyProfile>;
  /** Hits (source seconds) measured in the asset's beat grid, when there is a grid for this content; else null. */
  onsets(asset: string): Promise<readonly number[] | null>;
}

/** What `music.fit` was asked for. */
export interface MusicFitRequest {
  clip: string;
  end: number | string;
  from?: number | string | undefined;
  hit?: number | undefined;
  exact: boolean;
  skip?: readonly string[] | undefined;
  /** Give the clip the entry fade (default true; `music.candidates` plans without, it writes its own clips). */
  entryFade?: boolean | undefined;
  /** Nothing is written: warnings say what would happen, not what happened. */
  dryRun?: boolean | undefined;
}

/** A fit before anything is written: the report, and the operations that make it. */
export interface MusicFitPlan extends Omit<MusicFitResult, "timeline" | "revision" | "dryRun" | "applied" | "tx"> {
  /** Clip operations to apply in order (each names the clip); empty when nothing changes. */
  operations: ({ clip: string } & FitOperation)[];
  /**
   * Duck to run again in the same transaction: the music track, the tracks to listen to and the parameters of the duck
   * that wrote the clip's keys (`audio.duck`); `settings` is null when the clip has none stored (the method's defaults
   * apply). Null when no duck runs.
   */
  duckAgain: { track: string; under: string[]; settings: DuckSettings | null } | null;
  /**
   * Music shape to run again in the same transaction, before the duck: the clip's `music` keys sit on its own clock and the
   * hits they stepped down for are on the picture. `curve` is the stored shaping at the clip's new length. Null when none runs.
   */
  shapeAgain: { clip: string; curve: DipPoint[]; settings: ShapeSettings } | null;
}

const BINARY_ERRORS: readonly number[] = [ErrorCode.BinaryUnavailable, ErrorCode.BinaryNotFound, ErrorCode.BinaryInstallFailed, ErrorCode.BinaryChecksumMismatch];

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.fit: ${message}`, { op: "music.fit", ...data });

/**
 * The fit of music clip `request.clip` of `timeline` to `request.end`: the clip is found, `end` and `from` resolved by the
 * shared TimeRef resolver, the final hit given or found on the energy (and placed on the beat grid's hits when there is
 * one), then {@link planFit} does the arithmetic. Reads only. Throws ClipNotFound, InvalidOperation, or the `Binary*`
 * errors when ffmpeg cannot be fetched to decode the music.
 */
export async function planMusicFit(timeline: Timeline, fps: number, request: MusicFitRequest, deps: MusicFitDeps): Promise<MusicFitPlan> {
  const { track, clip } = findMusicClip(timeline, request.clip);
  const end = await resolveTimeRefArg("music.fit", "end", request.end, timeline, deps.loadGrid);
  const from = request.from === undefined ? undefined : await resolveTimeRefArg("music.fit", "from", request.from, timeline, deps.loadGrid);

  const warnings: string[] = [];
  let hit: MusicFitResult["hit"];
  if (request.hit !== undefined) {
    hit = { at: request.hit, source: "given", confidence: 1, rise: null, candidates: [] };
  } else {
    const profile = await deps.profile(clip.asset).catch((error: unknown) => {
      if (error instanceof RpcError && BINARY_ERRORS.includes(error.code)) throw error;
      throw invalid(`${clip.asset} cannot be decoded (${error instanceof Error ? error.message : String(error)}), so its final hit cannot be found.`, {
        reason: "undecodable",
        field: "clip",
        hint: "Pass `hit` (source seconds of the final hit).",
      });
    });
    const found = finalHit(profile.db, { from: clip.in, to: clip.out }, await deps.onsets(clip.asset).catch(() => null) ?? undefined);
    if (!found) {
      throw invalid(`no final hit found in the part of ${clip.asset} that clip ${clip.id} plays (${clip.in} to ${clip.out} s of the file): no sharp jump in level near loud music.`, {
        reason: "no hit",
        field: "hit",
        hint: "Pass `hit` (source seconds where the final hit begins), or widen the clip with `clip.trim`.",
      });
    }
    hit = { at: found.at, source: "detected", confidence: found.confidence, rise: found.rise, candidates: found.candidates.map(({ at, rise, level }) => ({ at, rise, level })) };
    if (found.confidence < MUSIC_FIT_MIN_CONFIDENCE) {
      if (request.exact) {
        throw invalid(`the final hit found at ${found.at} s of the file is doubtful (confidence ${found.confidence}); a doubtful hit never changes the speed.`, {
          reason: "low confidence",
          field: "hit",
          confidence: found.confidence,
          candidates: hit.candidates,
          hint: "Pass `hit` (source seconds of the final hit; `hit.candidates` of a dry run lists the strong ones), or drop `exact` to slide the clip.",
        });
      }
      warnings.push(
        `The final hit at ${found.at} s of the file is doubtful (confidence ${found.confidence}): the track may fade out or go on after its last accent. Check \`hit.candidates\`, and pass \`hit\` to be sure.`,
      );
    }
  }

  const plan = planFit({ clip: { start: clip.start, in: clip.in, out: clip.out, speed: clip.speed ?? 1 }, end, from, hit: hit.at, exact: request.exact, fps });
  const entryFade = request.entryFade !== false && needsEntryFade(clip) && request.skip?.includes("fade") !== true;
  // With only the fade to write, "nothing to change" would be wrong.
  warnings.push(
    ...plan.warnings.map((warning) =>
      entryFade && plan.operations.length === 0 && warning.startsWith("The final hit already lands") ? `${warning.replace(": nothing to change.", ".")} Only the fade in is written.` : warning,
    ),
  );
  checkRoom(track.id, track.clips, clip, plan, fps);

  const keyed = clip.keys?.gain?.some((key) => key.auto === "duck") === true;
  const changes = plan.operations.length > 0;
  const operations: ({ clip: string } & FitOperation)[] = plan.operations.map((operation) => ({ ...operation, clip: clip.id }) as MusicFitPlan["operations"][number]);
  let duck: MusicFitResult["duck"] = null;
  let duckAgain: MusicFitPlan["duckAgain"] = null;
  let shapeAgain: MusicFitPlan["shapeAgain"] = null;
  const steps = [...plan.steps];
  if (entryFade) {
    operations.push({ clip: clip.id, op: "clip.set", args: { audioFadeInMs: MUSIC_ENTRY_FADE_MS } });
    steps.push({ id: "fade", detail: `${MUSIC_ENTRY_FADE_MS} ms fade in at the start of ${clip.id} (audio.fadeInMs)`, skippable: true });
  }
  if (keyed && changes) {
    const rerun = planDuckAgain(timeline, track.id, clip, { skipped: request.skip?.includes("duck") === true, dryRun: request.dryRun === true });
    duck = rerun.duck;
    duckAgain = rerun.duckAgain;
    warnings.push(rerun.warning);
    if (rerun.duck.under.length > 0) steps.push({ id: "duck", detail: `run duck again on ${track.id} over ${rerun.duck.under.join(", ")}`, skippable: true });
  }
  const shaped = clip.keys?.gain?.some((key) => key.auto === "music" || key.baseAuto === "music") === true;
  if (shaped && changes) {
    const settings = clip.audio?.shape;
    const length = round3(clipEnd(plan.after));
    if (!settings) {
      warnings.push(`${clip.id} carries music keys (\`music shape\`) with no settings stored: they no longer line up with the picture; run \`music shape\` again.`);
    } else if (request.skip?.includes("shape") === true) {
      warnings.push(`${clip.id} carries music keys, which no longer line up with the picture (skipped): run \`music shape\` again.`);
    } else if (keyed && duck?.rerun !== true) {
      // Shaping again drops the duck keys: without the duck to put them back, the keys stay as they are.
      warnings.push(`${clip.id} carries music keys, which no longer line up with the picture: not run again, since the duck keys could not be put back. Run \`music shape\` and \`duck\` again.`);
    } else {
      shapeAgain = { clip: clip.id, curve: shapeCurve(settings, length), settings };
      warnings.push(`${clip.id} carries music keys: music shape ${request.dryRun === true ? "would run" : "ran"} again with the settings of its last run, at the same times of the picture.`);
      steps.push({ id: "shape", detail: `run music shape again on ${clip.id} (hits at ${(settings.drops ?? []).join(", ") || "none"}${settings.ending === undefined ? "" : `, ending ${settings.ending} s`})`, skippable: true });
    }
  }
  // `duck`, `shape` and `fade` are always accepted: an agent that passes them every time gets no error when there is nothing to skip.
  checkSkip(request.skip, [...new Set([...steps.filter((step) => step.skippable).map((step) => step.id), "duck", "shape", "fade"])]);

  const place = (clipPlace: FitPlan["after"]): MusicFitResult["after"] => ({ start: clipPlace.start, in: clipPlace.in, speed: clipPlace.speed, end: round3(clipEnd(clipPlace)) });
  return {
    mode: plan.mode,
    clip: clip.id,
    track: track.id,
    asset: clip.asset,
    end: plan.end,
    hit,
    before: place(plan.before),
    after: place(plan.after),
    landsAt: plan.landsAt,
    offsetMs: plan.offsetMs,
    speedChangePercent: plan.speedChangePercent,
    introCut: plan.introCut,
    silentBefore: plan.silentBefore,
    tail: plan.tail,
    duck,
    steps,
    warnings,
    operations,
    duckAgain,
    shapeAgain,
  };
}

/** `Music fit: c_1a2b3c lands its last hit on 30 s`. */
export function musicFitLabel(plan: Pick<MusicFitPlan, "clip" | "landsAt" | "mode">): string {
  return `Music fit: ${plan.clip} lands its last hit on ${plan.landsAt} s${plan.mode === "exact" ? " (varispeed)" : ""}`;
}

/** The media clip `id` of an audio track of `timeline`: the music `op` works on. Throws ClipNotFound, or InvalidOperation for anything else. */
export function findMusicClip(timeline: Timeline, id: string, op = "music.fit"): { track: ClipTrack; clip: MediaClip } {
  const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `${op}: ${message}`, { op, ...data });
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const clip = (track.clips as readonly AnyClip[]).find((candidate) => candidate.id === id);
    if (!clip) continue;
    if (track.kind === "program") {
      throw invalid(`${id} is a shot of a program track, not music.`, { reason: "not music", field: "clip", hint: "Name a media clip of an audio track (`timeline.show`)." });
    }
    if (track.kind !== "audio") {
      throw invalid(`${id} is on ${track.kind} track ${track.id}: music is a clip of an audio track.`, {
        reason: "not music",
        field: "clip",
        hint: "Move it to an audio track with `clip.move`, or name another clip.",
      });
    }
    if (!("asset" in clip)) {
      throw invalid(`${id} is a ${clip.type} clip: only a media clip is music.`, { reason: "not music", field: "clip", hint: "Name a media clip of an audio track (`timeline.show`)." });
    }
    return { track, clip };
  }
  throw new RpcError(ErrorCode.ClipNotFound, `${op}: no clip "${id}" in timeline ${timeline.id}. List clip ids with \`frameshell timeline show\`.`, { clip: id });
}

/**
 * Whether duck runs again over a music clip that carries duck keys, and over which tracks: the tracks of the duck that wrote
 * them (`audio.duck`) that still exist, else every other video or audio track that plays and is not ducked itself.
 * `warning` says what happens.
 */
export function planDuckAgain(
  timeline: Timeline,
  trackId: string,
  clip: MediaClip,
  options: { skipped: boolean; dryRun: boolean },
): { duck: NonNullable<MusicFitResult["duck"]>; duckAgain: MusicFitPlan["duckAgain"]; warning: string } {
  const stored = clip.audio?.duck && storedUnder(timeline, trackId, clip.audio.duck).length > 0 ? clip.audio.duck : null;
  const under = stored ? storedUnder(timeline, trackId, stored) : voiceTracks(timeline, trackId);
  const parameters = stored ? "stored" : "defaults";
  if (under.length === 0) {
    return {
      duck: { under, rerun: false, parameters },
      duckAgain: null,
      warning: `${clip.id} carries duck keys, which no longer line up with the voice, and there is no other video or audio track to listen to: run \`duck\` again by hand.`,
    };
  }
  if (options.skipped) {
    return {
      duck: { under, rerun: false, parameters },
      duckAgain: null,
      warning: `${clip.id} carries duck keys, which no longer line up with the voice (skipped): run \`duck ${trackId} --under ${under.join(" --under ")}\` again.`,
    };
  }
  return {
    duck: { under, rerun: true, parameters },
    duckAgain: { track: trackId, under, settings: stored },
    warning: `${clip.id} carries duck keys: duck ${options.dryRun ? "would run" : "ran"} again on ${trackId} over ${under.join(", ")} with ${stored ? "the parameters of its last run" : "its defaults (the clip has none stored)"}, replacing the old duck keys of every clip of that track.`,
  };
}

/** Tracks duck listens to when a fit runs it again: video and audio tracks that play, other than the music's and any other ducked one. */
function voiceTracks(timeline: Timeline, music: string): string[] {
  const ducked = (clips: readonly AnyClip[]) => clips.some((clip) => "keys" in clip && clip.keys?.gain?.some((key) => key.auto === "duck"));
  return timeline.tracks
    .filter((track) => (track.kind === "video" || track.kind === "audio") && track.id !== music && track.muted !== true && !ducked(track.clips))
    .map((track) => track.id);
}

/** The tracks of a stored duck that still exist as video or audio tracks, other than the music's own. */
function storedUnder(timeline: Timeline, music: string, settings: DuckSettings): string[] {
  return settings.under.filter((id) => id !== music && timeline.tracks.some((track) => track.id === id && (track.kind === "video" || track.kind === "audio")));
}

/** Refuse before writing when the clip's new place would overlap another clip of its track (the engine would refuse mid-fit). */
function checkRoom(trackId: string, clips: readonly AnyClip[], clip: MediaClip, plan: FitPlan, fps: number): void {
  const grid = new FrameGrid(fps);
  const frame = (seconds: number) => grid.frame(seconds);
  const [first, last] = [frame(plan.after.start), frame(clipEnd(plan.after))];
  for (const other of clips) {
    if (other.id === clip.id) continue;
    const length = clipLength(other as Parameters<typeof clipLength>[0], { fps });
    if (!Number.isFinite(length)) continue;
    const [from, to] = [frame(other.start), frame(other.start + length)];
    if (first < to && from < last) {
      throw invalid(`the fitted clip would play ${round3(plan.after.start)}–${round3(clipEnd(plan.after))} s and overlap ${other.id} (${other.start}–${round3(other.start + length)}) on track ${trackId}.`, {
        reason: "overlap",
        field: "clip",
        hint: "Clips on one track cannot overlap: put the music on its own audio track (`track.add`, `clip.move --track`), or trim the other clip.",
      });
    }
  }
}

function checkSkip(skip: readonly string[] | undefined, valid: readonly string[]): void {
  const unknown = (skip ?? []).filter((id) => !valid.includes(id));
  if (unknown.length === 0) return;
  throw invalid(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a step that can be skipped here.`, {
    reason: "skip",
    field: "skip",
    valid,
    hint: valid.length > 0 ? `Skippable steps of this fit: ${valid.join(", ")}.` : "This fit has no step that can be skipped (a dry run lists its `steps`).",
  });
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
