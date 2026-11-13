import { ErrorCode, type MusicShapeResult, RpcError } from "@frameshell/protocol";
import type { ShapeSettings, Timeline } from "@frameshell/schema";
import type { DipPoint } from "../media/duck.js";
import { type GridLoader, resolveTimeRefArg } from "../timeline/time-ref.js";
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
  lead: number;
  depth: number;
  hold: number;
  release: number;
  fade: number;
  /** Remove the clip's music keys instead. */
  clear?: boolean | undefined;
  dryRun?: boolean | undefined;
}

/** A shaping before anything is written. */
export interface MusicShapePlan extends Omit<MusicShapeResult, "timeline" | "revision" | "dryRun" | "applied" | "tx"> {
  /** What the `music.shape` operation takes: the dip curve (empty to clear) and the settings kept on the clip. */
  operation: { clip: string; curve: DipPoint[]; settings: ShapeSettings | null };
  /** Duck to run again after the keys are written (they replace the clip's duck keys); null when the clip has none. */
  duckAgain: MusicFitPlan["duckAgain"];
  /** True for `clear` on a clip with no music keys: nothing to write. */
  noop: boolean;
}

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.shape: ${message}`, { op: "music.shape", ...data });
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The shaping of music clip `request.clip` of `timeline` (ADR 0037 slice 4): hits and ending resolved by the shared
 * TimeRef resolver, the dip curve ({@link shapeCurve}) over the clip, and the duck that goes again after it when the clip
 * carries duck keys. Reads only. Throws ClipNotFound or InvalidOperation.
 */
export async function planMusicShape(timeline: Timeline, request: MusicShapeRequest, loadGrid: GridLoader): Promise<MusicShapePlan> {
  const { track, clip } = findMusicClip(timeline, request.clip, "music.shape");
  const warnings: string[] = [];
  const keyed = clip.keys?.gain?.some((key) => key.auto === "music" || key.baseAuto === "music") === true;
  const ducked = clip.keys?.gain?.some((key) => key.auto === "duck") === true;
  const playsFrom = clip.start;
  const playsTo = clipEnd({ start: clip.start, in: clip.in, out: clip.out, speed: clip.speed ?? 1 });

  const given = (request.drop?.length ?? 0) > 0 || request.ending !== undefined;
  if (request.clear === true && given) throw invalid("`clear` removes the clip's music keys and takes no `drop` or `ending`.", { reason: "clear", field: "clear" });
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
    for (const value of request.drop ?? []) resolved.push(round3(await resolveTimeRefArg("music.shape", "drop", value, timeline, loadGrid)));
    for (const at of [...new Set(resolved)].sort((a, b) => a - b)) {
      // A hit whose dip never reaches the clip writes nothing.
      if (at + settings.hold + settings.release <= playsFrom || at - settings.lead - SHAPE_STEP_S >= playsTo) {
        warnings.push(`The hit at ${at} s is outside ${clip.id} (${round3(playsFrom)}–${round3(playsTo)} s): left out.`);
      } else drops.push(at);
    }
    if (request.ending !== undefined) {
      const at = round3(await resolveTimeRefArg("music.shape", "ending", request.ending, timeline, loadGrid));
      if (at >= playsTo) warnings.push(`The ending at ${at} s is after ${clip.id} ends (${round3(playsTo)} s): no fade written.`);
      else {
        ending = at;
        if (at + settings.fade > playsTo) warnings.push(`The clip ends at ${round3(playsTo)} s, before the ${settings.fade} s fade from ${at} s is over: it is cut off there.`);
      }
    }
    if (drops.length === 0 && ending === null) {
      throw invalid(`none of the times falls on ${clip.id} (${round3(playsFrom)}–${round3(playsTo)} s): nothing to shape.`, { reason: "outside", field: "drop", clip: clip.id });
    }
    if (drops.length > 0) settings.drops = drops;
    if (ending !== null) settings.ending = ending;
  } else if (!keyed) {
    warnings.push(`${clip.id} has no music keys: nothing to clear.`);
  }

  const curve = settings ? shapeCurve(settings, playsTo) : [];
  const steps: MusicShapeResult["steps"] = [
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
  return { clip: clip.id, track: track.id, asset: clip.asset, cleared: settings === null, drops, ending, settings, curve, duck, steps, warnings, operation: { clip: clip.id, curve, settings }, duckAgain, noop: settings === null && !keyed };
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
