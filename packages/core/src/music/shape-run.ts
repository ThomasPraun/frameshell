import { ErrorCode, type MusicShapeResult, RpcError } from "@frameshell/protocol";
import { AUDIO_EFFECT_LIMITS, type AudioEffect, type ShapeSettings, type Timeline, isBuild } from "@frameshell/schema";
import type { DipPoint } from "../media/duck.js";
import type { TimelineGrid } from "../timeline/tempo.js";
import { type GridLoader, type WordLoader, onceWords, resolveTimeRefArg, unusableGrid } from "../timeline/time-ref.js";
import { type MusicBuild, planBuildEffects } from "./builds.js";
import { MUSIC_ENTRY_FADE_MS, needsEntryFade } from "./entry-fade.js";
import { clipEnd } from "./fit.js";
import { type MusicFitPlan, findMusicClip, planDuckAgain } from "./run.js";
import { SHAPE_STEP_S, shapeCurve } from "./shape.js";

/** What `music.shape` was asked, with the numbers filled in. */
export interface MusicShapeRequest {
  clip: string;
  /** Hits of the picture the music steps down before: timeline times (seconds or a name). */
  drop?: readonly (number | string)[] | undefined;
  /** Where the closing fade begins: a timeline time. */
  ending?: number | string | undefined;
  /** The closing fade ends on a bar start of the timeline's grid: `fade` is stretched or shrunk to reach the nearest one. */
  endOnBar?: boolean | undefined;
  lead: number;
  depth: number;
  hold: number;
  release: number;
  fade: number;
  /** Seconds of a swept high-pass build that ends at each hit (`highpassSweep` effects); none when absent. */
  build?: number | undefined;
  /** Cutoff in Hz the build starts at; default {@link AUDIO_EFFECT_LIMITS}. */
  buildFrom?: number | undefined;
  /** Cutoff in Hz the build reaches just before the hit. */
  buildTo?: number | undefined;
  /** Remove the clip's music keys (and builds) instead. */
  clear?: boolean | undefined;
  dryRun?: boolean | undefined;
}

/** A shaping before anything is written. */
export interface MusicShapePlan extends Omit<MusicShapeResult, "timeline" | "revision" | "dryRun" | "applied" | "tx"> {
  /** What the `music.shape` operation takes: the dip curve (empty to clear) and the settings kept on the clip. */
  operation: { clip: string; curve: DipPoint[]; settings: ShapeSettings | null };
  /**
   * The clip's whole `audio.effects` list to write with `clip.set audioEffects` before the keys (null clears it);
   * undefined when the builds leave the list as it is.
   */
  effects: AudioEffect[] | null | undefined;
  /** Duck to run again after the keys are written (they replace the clip's duck keys); null when the clip has none. */
  duckAgain: MusicFitPlan["duckAgain"];
  /** True when the clip gets the {@link MUSIC_ENTRY_FADE_MS} fade in (`audio.fadeInMs`) before its keys. */
  entryFade: boolean;
  /** True for `clear` on a clip with no music keys: nothing to write. */
  noop: boolean;
}

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.shape: ${message}`, { op: "music.shape", ...data });
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Shortest and longest closing fade of `music.shape`, seconds (the method's `fade` limits). */
const MIN_FADE_S = 0.05;
const MAX_FADE_S = 15;

/**
 * The shaping of music clip `request.clip` of `timeline` (ADR 0037): hits and ending resolved by the shared
 * TimeRef resolver, the dip curve ({@link shapeCurve}) over the clip, and the duck that goes again after it when the clip
 * carries duck keys. `loadWords` reads the words the timeline plays for `word:` references. Reads only. Throws
 * ClipNotFound or InvalidOperation.
 */
export async function planMusicShape(timeline: Timeline, request: MusicShapeRequest, loadGrid: GridLoader, loadWords?: WordLoader): Promise<MusicShapePlan> {
  const words = onceWords(loadWords);
  const { track, clip } = findMusicClip(timeline, request.clip, "music.shape");
  const warnings: string[] = [];
  const keyed = clip.keys?.gain?.some((key) => key.auto === "music" || key.baseAuto === "music") === true;
  const existingBuilds = (clip.audio?.effects ?? []).some(isBuild);
  const ducked = clip.keys?.gain?.some((key) => key.auto === "duck") === true;
  const playsFrom = clip.start;
  const playsTo = clipEnd({ start: clip.start, in: clip.in, out: clip.out, speed: clip.speed ?? 1 });

  const given = (request.drop?.length ?? 0) > 0 || request.ending !== undefined;
  if (request.clear === true && (given || request.build !== undefined)) {
    throw invalid("`clear` removes the clip's music keys and builds and takes no `drop`, `ending` or `build`.", { reason: "clear", field: "clear" });
  }
  if (request.endOnBar === true && request.ending === undefined) {
    throw invalid("`endOnBar` snaps the end of the closing fade to a bar line: give `ending` (where the fade begins) too.", { reason: "endOnBar", field: "ending", hint: "Example: `{ clip, ending: 28, endOnBar: true }`." });
  }
  if (request.endOnBar === true && request.clear === true) {
    throw invalid("`clear` removes the clip's music keys and takes no `endOnBar`.", { reason: "clear", field: "clear" });
  }
  if (request.build !== undefined && (request.drop?.length ?? 0) === 0) {
    throw invalid("`build` is the rising high-pass before a hit: give `drop` too.", { reason: "build", field: "build", hint: "Example: `{ clip, drop: [\"hit\"], build: 2 }`." });
  }
  if (request.build === undefined && (request.buildFrom !== undefined || request.buildTo !== undefined)) {
    throw invalid("`buildFrom` and `buildTo` set the cutoffs of a build: give `build` (its length in seconds) too.", { reason: "build", field: "build" });
  }
  if (request.clear !== true && !given) {
    throw invalid("nothing to shape: give `drop` (the time of a hit to step down before), `ending` (where the closing fade begins), or `clear`.", {
      reason: "empty",
      field: "drop",
      hint: "Example: `{ clip, drop: [\"hit\"], ending: 28 }`.",
    });
  }

  const settings: ShapeSettings | null = request.clear === true ? null : { lead: request.lead, depth: request.depth, hold: request.hold, release: request.release, fade: request.fade };
  const drops: number[] = [];
  let ending: number | null = null;
  if (settings) {
    const resolved: number[] = [];
    for (const value of request.drop ?? []) resolved.push(round3(await resolveTimeRefArg("music.shape", "drop", value, timeline, loadGrid, words)));
    for (const at of [...new Set(resolved)].sort((a, b) => a - b)) {
      // A hit whose dip never reaches the clip writes nothing.
      if (at + settings.hold + settings.release <= playsFrom || at - settings.lead - SHAPE_STEP_S >= playsTo) {
        warnings.push(`The hit at ${at} s is outside ${clip.id} (${round3(playsFrom)}–${round3(playsTo)} s): left out.`);
      } else drops.push(at);
    }
    if (request.ending !== undefined) {
      const at = round3(await resolveTimeRefArg("music.shape", "ending", request.ending, timeline, loadGrid, words));
      if (at >= playsTo) warnings.push(`The ending at ${at} s is after ${clip.id} ends (${round3(playsTo)} s): no fade written.`);
      else {
        ending = at;
        if (request.endOnBar === true) {
          const barEnd = await barEndOf(at, settings.fade, { grid: loadGrid, horizon: playsTo + settings.fade + 30 });
          if (barEnd.fade !== settings.fade) {
            warnings.push(`The closing fade from ${at} s ends on bar line ${barEnd.at} s (${barEnd.ref}): ${barEnd.fade} s instead of ${settings.fade} s.`);
            settings.fade = barEnd.fade;
          }
        }
        if (at + settings.fade > playsTo) warnings.push(`The clip ends at ${round3(playsTo)} s, before the ${settings.fade} s fade from ${at} s is over: it is cut off there.`);
      }
    }
    if (drops.length === 0 && ending === null) {
      throw invalid(`none of the times falls on ${clip.id} (${round3(playsFrom)}–${round3(playsTo)} s): nothing to shape.`, { reason: "outside", field: "drop", clip: clip.id });
    }
    if (drops.length > 0) settings.drops = drops;
    if (ending !== null) settings.ending = ending;
  } else if (!keyed && !existingBuilds) {
    warnings.push(`${clip.id} has no music keys: nothing to clear.`);
  }

  // A run replaces the builds it wrote earlier (`auto: "music"`) and keeps every other effect, like it does for keys.
  const { startHz, endHz } = AUDIO_EFFECT_LIMITS.highpassSweep;
  const build: MusicBuild | undefined =
    settings && request.build !== undefined ? { seconds: request.build, startHz: request.buildFrom ?? startHz.default, endHz: request.buildTo ?? endHz.default } : undefined;
  const { sweeps, effects } = planBuildEffects(clip, settings ? drops : [], build, warnings);
  if (settings && sweeps.length > 0 && build) settings.build = build;

  const curve = settings ? shapeCurve(settings, playsTo) : [];
  // A shaping re-shapes the music's entry too (ADR 0037); `clear` leaves the clip's edges alone.
  const entryFade = settings !== null && needsEntryFade(clip);
  const steps: MusicShapeResult["steps"] = [
    ...(entryFade ? [{ id: "fade" as const, detail: `${MUSIC_ENTRY_FADE_MS} ms fade in at the start of ${clip.id} (audio.fadeInMs)` }] : []),
    ...(effects === undefined
      ? []
      : [
          {
            id: "sweep" as const,
            detail:
              sweeps.length > 0
                ? `high-pass builds on ${clip.id}: ${sweeps.map((sweep) => `${sweep.startHz} to ${sweep.endHz} Hz over ${round3(sweep.to - sweep.from)} s of the file before ${sweep.at} s`).join(", ")}`
                : `remove the high-pass builds of ${clip.id}`,
          },
        ]),
    {
      id: "shape",
      detail: settings
        ? `write music keys on ${clip.id}: ${[
            ...drops.map((at) => `step down ${settings.depth} dB ${settings.lead} s before ${at} s`),
            ...(ending === null ? [] : [`fade out from ${ending} s over ${settings.fade} s`]),
          ].join(", ")}`
        : `remove the music keys of ${clip.id}`,
    },
  ];
  let duck: MusicShapeResult["duck"] = null;
  let duckAgain: MusicShapePlan["duckAgain"] = null;
  if (ducked) {
    const rerun = planDuckAgain(timeline, track.id, clip, { skipped: false, dryRun: request.dryRun === true });
    warnings.push(rerun.warning.replace("which no longer line up with the voice", "which the shaping replaces"));
    duck = rerun.duck;
    duckAgain = rerun.duckAgain;
    if (rerun.duckAgain) steps.push({ id: "duck", detail: `run duck again on ${track.id} over ${rerun.duck.under.join(", ")}` });
  }
  return {
    clip: clip.id,
    track: track.id,
    asset: clip.asset,
    cleared: settings === null,
    drops,
    ending,
    endsAt: ending === null || settings === null ? null : round3(ending + settings.fade),
    settings,
    curve,
    sweeps,
    duck,
    steps,
    warnings,
    operation: { clip: clip.id, curve, settings },
    effects,
    duckAgain,
    entryFade,
    noop: settings === null && !keyed && effects === undefined,
  };
}

/**
 * The bar start of the timeline's grid a fade of `fade` seconds from `ending` should end on: the nearest to `ending + fade`
 * that leaves a fade of at least {@link MIN_FADE_S} and at most {@link MAX_FADE_S} (the earlier one on a tie). Throws
 * InvalidOperation when the timeline has no usable grid or no bar start is that near.
 */
async function barEndOf(ending: number, fade: number, source: { grid: GridLoader; horizon: number }): Promise<{ at: number; fade: number; ref: string }> {
  const found = await source.grid(source.horizon);
  const unusable = unusableGrid(found);
  if (unusable) throw invalid(unusable.message, { reason: "grid", field: "endOnBar", ...(unusable.hint ? { hint: unusable.hint } : {}) });
  const grid = found.grid as TimelineGrid;
  const wanted = ending + fade;
  const bars = grid.bars.filter((bar) => bar - ending >= MIN_FADE_S - 1e-9 && bar - ending <= MAX_FADE_S + 1e-9);
  if (bars.length === 0) {
    throw invalid(`no bar start of the grid is between ${MIN_FADE_S} and ${MAX_FADE_S} s after the ending at ${ending} s.`, {
      reason: "endOnBar",
      field: "endOnBar",
      hint: "Give an `ending` inside the music the grid follows, or drop `endOnBar`.",
    });
  }
  const at = bars.reduce((near, bar) => (Math.abs(bar - wanted) < Math.abs(near - wanted) - 1e-9 ? bar : near));
  return { at: round3(at), fade: round3(at - ending), ref: `bar:${grid.bars.indexOf(at) + 1 + grid.barBase}` };
}

/** `Music shape: c_1a2b3c steps down before 12.4 s, fades out from 28 s` / `Music shape: c_1a2b3c cleared`. */
export function musicShapeLabel(plan: Pick<MusicShapePlan, "clip" | "drops" | "ending" | "cleared">): string {
  if (plan.cleared) return `Music shape: ${plan.clip} cleared`;
  const parts = [
    ...(plan.drops.length > 0 ? [`steps down before ${plan.drops.join(", ")} s`] : []),
    ...(plan.ending === null ? [] : [`fades out from ${plan.ending} s`]),
  ];
  return `Music shape: ${plan.clip} ${parts.join(", ")}`;
}
