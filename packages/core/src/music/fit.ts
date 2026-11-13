import { ErrorCode, MUSIC_FIT_MAX_VARISPEED, type MusicFitResult, RpcError } from "@frameshell/protocol";
import { FrameGrid } from "../timeline/grid.js";

/**
 * The arithmetic of `music.fit` (ADR 0037): where a music clip goes, and at what speed, so that its final hit lands on a
 * cut. Pure: `run.ts` finds the clip and the hit, `daemon.ts` writes the result with the clip operations.
 */

/** The fields of a media clip a fit reads and writes. Seconds. */
export interface FitClip {
  /** Timeline seconds of the first frame. */
  start: number;
  /** Source seconds of the first frame. */
  in: number;
  /** Source seconds just after the last frame. */
  out: number;
  /** Playback rate; 1 = normal. */
  speed: number;
}

/** What to fit. */
export interface FitRequest {
  clip: FitClip;
  /** Timeline seconds the hit lands on. */
  end: number;
  /** Earliest timeline second the music may start, else 0 (slide) or the clip's own start (`exact`). */
  from?: number | undefined;
  /** Source seconds of the hit; inside (`clip.in`, `clip.out`]. */
  hit: number;
  exact: boolean;
  fps: number;
}

/** A clip operation a fit makes, in the order to apply. */
export type FitOperation =
  | { op: "clip.trim"; args: { in: number; snap: false } }
  | { op: "clip.move"; args: { start: number } }
  | { op: "clip.set"; args: { speed: number } }
  | { op: "clip.set"; args: { audioFadeInMs: number } };

/** The fit: the clip as it ends up, the operations that get it there and what to tell the person. */
export interface FitPlan
  extends Pick<MusicFitResult, "mode" | "end" | "landsAt" | "offsetMs" | "speedChangePercent" | "introCut" | "silentBefore" | "tail" | "steps" | "warnings"> {
  before: FitClip;
  after: FitClip;
  /** Clip operations, without the `clip` argument; empty when the clip already lands. */
  operations: FitOperation[];
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const MAX_PERCENT = round(MUSIC_FIT_MAX_VARISPEED * 100, 3);
/** How early the export's `atempo` plays material at speeds near 1: 1024 samples at 48 kHz (`music-atempo.test.ts`). */
const ATEMPO_LEAD_MS = 21;

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.fit: ${message}`, { op: "music.fit", ...data });

/** Seconds, for a sentence: `4.2 s`. */
const secs = (value: number) => `${round(value, 3)} s`;
const percent = (change: number) => `${change >= 0 ? "+" : ""}${round(change * 100, 2)} %`;

/** Playing time of a clip, seconds. */
export const clipEnd = (clip: FitClip) => clip.start + (clip.out - clip.in) / clip.speed;

/**
 * Plan the fit of `request.clip` to `request.end`. Throws InvalidOperation (with a `hint`) when the end is not after the
 * earliest start, the hit is not in the played part, or `exact` would need more than ±1.7 % of the clip's speed.
 */
export function planFit(request: FitRequest): FitPlan {
  const { clip, hit } = request;
  const g = new FrameGrid(request.fps);
  const end = g.snap(request.end);
  if (!(hit > clip.in && hit <= clip.out)) {
    throw invalid(`the hit at ${secs(hit)} is not in the part of the music the clip plays (${secs(clip.in)} to ${secs(clip.out)} of the file).`, {
      reason: "hit outside the clip",
      field: "hit",
      hint: "Pass a `hit` inside it, or trim the clip back out with `clip.trim` first.",
    });
  }
  return request.exact ? exactPlan(request, g, end) : slidePlan(request, g, end);
}

/**
 * Slide: keep the speed, move the clip. Where the clip would begin before `from`, the start of the track is dropped (`in`
 * later); where it would begin after `from` and the file has music before `in`, that music is brought back (`in` earlier,
 * down to 0), so a second fit with a later end leaves no gap the file could fill.
 */
function slidePlan(request: FitRequest, g: FrameGrid, end: number): FitPlan {
  const { clip, hit } = request;
  const from = g.snap(request.from ?? 0);
  if (end <= from) throw tooEarly(end, from, request.from !== undefined);
  const speed = clip.speed;
  let start = g.snap(end - (hit - clip.in) / speed);
  let inPoint = clip.in;
  if (start < from) {
    start = from;
    inPoint = g.snap(hit - (end - start) * speed);
    if (inPoint >= hit) throw tooEarly(end, from, request.from !== undefined);
  } else if (clip.in > 0 && g.frame(start) > g.frame(from)) {
    inPoint = Math.max(0, g.snap(hit - (end - from) * speed));
    start = Math.max(from, g.snap(end - (hit - inPoint) / speed));
  }
  const after: FitClip = { start, in: inPoint, speed, out: clip.out };
  const operations = headOperations(clip, after, g);

  const introCut = Math.max(0, round(inPoint - clip.in, 3));
  const introBack = Math.max(0, round(clip.in - inPoint, 3));
  const silentBefore = inPoint === 0 && start - from >= g.step / 2 ? round(start - from, 3) : 0;
  const warnings: string[] = [];
  if (introBack > 0) {
    warnings.push(`The clip played the file from ${secs(clip.in)}; the ${secs(introBack)} before it are back, so the music starts at ${secs(inPoint)} of the file and fills more of the picture before the hit.`);
  }
  if (introCut > 0) {
    warnings.push(
      `The track is longer than the picture before the hit: its first ${secs(introCut)} are dropped (it starts at ${secs(inPoint)} of the file), which can fall mid-phrase. ` +
        "Give `from` an earlier second, or `exact` to speed it up within 1.7 %, if the intro matters.",
    );
  }
  if (silentBefore > 0) {
    warnings.push(`The track is shorter than the picture before the hit: nothing plays in the first ${secs(silentBefore)} after ${secs(from)}. It is never looped or spliced.`);
  }
  const steps: FitPlan["steps"] = [];
  if (introCut > 0) steps.push({ id: "intro", detail: `drop ${secs(introCut)} of the intro (in ${secs(clip.in)} -> ${secs(inPoint)})`, skippable: false });
  if (introBack > 0) steps.push({ id: "intro", detail: `bring back ${secs(introBack)} of the intro (in ${secs(clip.in)} -> ${secs(inPoint)})`, skippable: false });
  if (g.frame(start) !== g.frame(clip.start)) steps.push({ id: "place", detail: `start ${secs(clip.start)} -> ${secs(start)}`, skippable: false });
  return finish("slide", request, after, end, operations, steps, warnings, { introCut, silentBefore, speedChange: null });
}

/**
 * The trim and move that take `clip` to `after`. A head trim moves the start with the first frame, so the move only closes
 * what is left; a head trim that brings music back moves the start earlier, so the clip is moved first to stay at 0 or later.
 */
function headOperations(clip: FitClip, after: FitClip, g: FrameGrid): FitOperation[] {
  const operations: FitOperation[] = [];
  const shift = (after.in - clip.in) / clip.speed;
  let at = clip.start;
  if (after.in < clip.in) {
    const first = g.snap(after.start - shift);
    if (g.frame(first) !== g.frame(at)) {
      operations.push({ op: "clip.move", args: { start: first } });
      at = first;
    }
  }
  if (after.in !== clip.in) {
    operations.push({ op: "clip.trim", args: { in: after.in, snap: false } });
    at = g.snap(at + shift);
  }
  if (g.frame(at) !== g.frame(after.start)) operations.push({ op: "clip.move", args: { start: after.start } });
  return operations;
}

/** Exact: keep the start (`from`, else where the clip starts), change the speed so the hit lands on `end`. */
function exactPlan(request: FitRequest, g: FrameGrid, end: number): FitPlan {
  const { clip, hit } = request;
  const start = g.snap(request.from ?? clip.start);
  if (end <= start) throw tooEarly(end, start, true);
  const before = hit - clip.in;
  const needed = before / (end - start);
  const change = needed / clip.speed - 1;
  if (Math.abs(change) > MUSIC_FIT_MAX_VARISPEED + 1e-9) throw tooFar(request, g, end, start, needed, change);
  const speed = Math.abs(change) < 1e-9 ? clip.speed : round(needed, 6);
  const after: FitClip = { start, in: clip.in, speed, out: clip.out };
  const operations: FitOperation[] = [];
  const steps: FitPlan["steps"] = [];
  const set: FitOperation | null = speed !== clip.speed ? { op: "clip.set", args: { speed } } : null;
  const move: FitOperation | null = g.frame(start) !== g.frame(clip.start) ? { op: "clip.move", args: { start } } : null;
  // The first operation leaves the clip half done for a moment: moving earlier first keeps it clear of a neighbour on its right.
  for (const operation of start < clip.start ? [move, set] : [set, move]) if (operation) operations.push(operation);
  if (set) steps.push({ id: "speed", detail: `speed ${clip.speed} -> ${speed} (${percent(speed / clip.speed - 1)})`, skippable: false });
  if (move) steps.push({ id: "place", detail: `start ${secs(clip.start)} -> ${secs(start)}`, skippable: false });
  const warnings =
    speed === clip.speed
      ? []
      : [
          `Export keeps the pitch with atempo, which starts about ${ATEMPO_LEAD_MS} ms early (measured, ADR 0037): the hit plays that much before ${secs(end)} in the export, a fraction of a frame; ` +
            "the preview has no such shift but plays the pitch up or down by up to 0.3 semitone until its stretch lands (#499).",
        ];
  return finish("exact", request, after, end, operations, steps, warnings, { introCut: 0, silentBefore: 0, speedChange: speed !== clip.speed ? (speed / clip.speed - 1) * 100 : null });
}

function finish(
  mode: FitPlan["mode"],
  request: FitRequest,
  after: FitClip,
  end: number,
  operations: FitOperation[],
  steps: FitPlan["steps"],
  warnings: string[],
  facts: { introCut: number; silentBefore: number; speedChange: number | null },
): FitPlan {
  const lands = after.start + (request.hit - after.in) / after.speed;
  if (operations.length === 0) warnings.push(`The final hit already lands on ${secs(end)}: nothing to change.`);
  return {
    mode,
    end,
    before: { ...request.clip },
    after,
    landsAt: round(lands, 3),
    offsetMs: round((lands - end) * 1000, 1),
    speedChangePercent: facts.speedChange === null ? null : round(facts.speedChange, 3),
    introCut: facts.introCut,
    silentBefore: facts.silentBefore,
    tail: round((after.out - request.hit) / after.speed, 3),
    operations,
    steps,
    warnings,
  };
}

function tooEarly(end: number, from: number, given: boolean): RpcError {
  return invalid(`the end ${secs(end)} is not after ${given ? "`from`" : "the start of the timeline"} (${secs(from)}).`, {
    reason: "end before start",
    field: "end",
    hint: "Give an `end` later than where the music may start, or an earlier `from`.",
  });
}

/** Refusal of `exact` past the bound: what it needs, which ends would fit, and what to do instead. */
function tooFar(request: FitRequest, g: FrameGrid, end: number, start: number, needed: number, change: number): RpcError {
  const { clip, hit } = request;
  const before = hit - clip.in;
  const early = g.ceil(start + before / (clip.speed * (1 + MUSIC_FIT_MAX_VARISPEED)));
  const late = g.floor(start + before / (clip.speed * (1 - MUSIC_FIT_MAX_VARISPEED)));
  const fits = early <= late ? `an \`end\` from ${secs(early)} to ${secs(late)}` : "no end on a frame";
  const slide = `without \`exact\` the clip slides instead and keeps its speed`;
  const longer = change > 0;
  return invalid(
    `landing the hit on ${secs(end)} from a start at ${secs(start)} needs the clip ${longer ? "faster" : "slower"} by ${round(Math.abs(change) * 100, 2)} %; the limit is ±${MAX_PERCENT} %.`,
    {
      reason: "varispeed limit",
      field: "exact",
      needed: { speed: round(needed, 6), percent: round(change * 100, 2), max: MAX_PERCENT },
      valid: { end: early <= late ? { min: early, max: late } : null },
      hint:
        `Move the end by a beat (${fits} lands within the limit), ${longer ? "trim the intro (`clip trim --in`)" : "start the music later with `from`"}, ` +
        `or drop \`exact\`: ${slide}.`,
    },
  );
}
