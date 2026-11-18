import type { ReviewBehind, ReviewBehindSample, ReviewFinding } from "@frameshell/protocol";
import { type LayerRect, type MediaClip, type Timeline, subjectOf } from "@frameshell/schema";
import { FrameGrid } from "../timeline/grid.js";
import type { Box } from "./safe.js";
import { BEHIND_EATEN, BEHIND_FINE, BEHIND_FLOATS, GRAPHIC_ALPHA } from "./thresholds.js";

// A word behind the person (ADR 0032, #461): how much of it the person covers, from the word's render alpha and the
// plate's matte, both placed in the film, at the first, middle and last frame of its time behind the person. Pure: the
// frames come from `placement.ts` (`alphaMask`, `matteFrame`), the gathering from `ReviewService`.

/** A grey picture, one byte a pixel, rows top down. */
export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** What {@link coveredShare} finds of one frame of a word. */
export interface Coverage {
  /** Share of the word's alpha (weighted by it) where the matte is the person, 0 to 1. */
  share: number;
  /** Box of the word's alpha, film pixels. */
  box: Box;
}

/**
 * The share of the word `graphic` (its alpha, the whole render laid out at `graphicRect` in the film) that the `matte`
 * of the plate (the whole picture laid out at `plateRect`) covers: alpha at or above {@link GRAPHIC_ALPHA}, weighted by
 * itself, times the matte (0 background, 255 person) at the same film point, nearest matte pixel. Outside the plate
 * the person is not. Null when the word draws nothing.
 */
export function coveredShare(graphic: Mask, graphicRect: LayerRect, matte: Mask, plateRect: LayerRect): Coverage | null {
  let weight = 0;
  let covered = 0;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const cellWidth = graphicRect.width / graphic.width;
  const cellHeight = graphicRect.height / graphic.height;
  for (let gy = 0; gy < graphic.height; gy++) {
    const top = graphicRect.top + gy * cellHeight;
    const v = (top + cellHeight / 2 - plateRect.top) / plateRect.height;
    const my = Math.floor(v * matte.height);
    for (let gx = 0; gx < graphic.width; gx++) {
      const alpha = graphic.data[gy * graphic.width + gx]!;
      if (alpha < GRAPHIC_ALPHA) continue;
      const left = graphicRect.left + gx * cellWidth;
      weight += alpha;
      x0 = Math.min(x0, left);
      y0 = Math.min(y0, top);
      x1 = Math.max(x1, left + cellWidth);
      y1 = Math.max(y1, top + cellHeight);
      const u = (left + cellWidth / 2 - plateRect.left) / plateRect.width;
      const mx = Math.floor(u * matte.width);
      if (mx < 0 || mx >= matte.width || my < 0 || my >= matte.height) continue;
      covered += (alpha * matte.data[my * matte.width + mx]!) / 255;
    }
  }
  return weight === 0 ? null : { share: covered / weight, box: { x0, y0, x1, y1 } };
}

/** Whether boxes `a` and `b` overlap (touching edges do not). */
export function boxesMeet(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

/**
 * Proxy frame (= matte frame, ADR 0032) that `clip` shows at timeline frame `frame` (at `fps`), as export picks it:
 * `pieceChain` seeks to `round(in × fps) + (frame - start frame) × speed` and its `fps` filter rounds half down. Twin of
 * `sourceFrameAt` in `apps/desktop/src/renderer/src/preview/decode-plan.ts` (the preview's rounding, matched to export).
 */
export function matteFrameAt(clip: { start: number; in: number; speed?: number | undefined }, frame: number, fps: number): number {
  const grid = new FrameGrid(fps);
  return Math.max(0, Math.ceil(grid.frame(clip.in) + (frame - grid.frame(clip.start)) * (clip.speed ?? 1) - 0.5));
}

/** A plate clip drawn as the subject (`withSubjectLayers`) over `[from, to)` timeline seconds. */
export interface SubjectSpan<C = MediaClip> {
  clip: C;
  from: number;
  to: number;
}

/**
 * Where the subject of plate track `plate` is drawn in a flattened `timeline`: each subject clip's windows (source
 * seconds of its mark) as timeline seconds, in time order.
 */
export function subjectSpans(timeline: Timeline, plate: string): SubjectSpan<MediaClip>[] {
  const found: SubjectSpan<MediaClip>[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const mark = subjectOf(clip);
      if (!mark || mark.plate !== plate || clip.type !== "media" || !("asset" in clip)) continue;
      const speed = clip.speed ?? 1;
      for (const [a, b] of mark.windows) found.push({ clip, from: clip.start + (a - clip.in) / speed, to: clip.start + (b - clip.in) / speed });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** `spans` cut to `[from, to)`, empty ones dropped. */
export function within<S extends { from: number; to: number }>(spans: readonly S[], from: number, to: number): S[] {
  return spans.flatMap((span) => {
    const cut = { ...span, from: Math.max(span.from, from), to: Math.min(span.to, to) };
    return cut.to > cut.from + 1e-9 ? [cut] : [];
  });
}

/**
 * Timeline frames (at `fps`) to measure in `spans`: the first frame that starts inside the first span, the last that
 * starts inside the last one, and the one nearest their middle that starts inside a span. Each once, in order.
 */
export function sampleFrames(spans: readonly { from: number; to: number }[], fps: number): number[] {
  const frames = spans.flatMap((span) => {
    const first = Math.ceil(span.from * fps - 1e-6);
    const last = Math.ceil(span.to * fps - 1e-6) - 1;
    return last >= first ? [[first, last] as const] : [];
  });
  if (frames.length === 0) return [];
  const first = frames[0]![0];
  const last = frames.at(-1)![1];
  const middle = (first + last) / 2;
  let nearest = first;
  for (const [a, b] of frames) {
    const candidate = Math.min(b, Math.max(a, Math.round(middle)));
    if (Math.abs(candidate - middle) < Math.abs(nearest - middle)) nearest = candidate;
  }
  return [...new Set([first, nearest, last])].sort((a, b) => a - b);
}

/** Distance of `share` from the fine range {@link BEHIND_FINE}: 0 inside it. */
const offFine = (share: number) => Math.max(0, BEHIND_FINE[0] - share, share - BEHIND_FINE[1]);

/** The verdict of the shares measured (nulls left out): from the one farthest from {@link BEHIND_FINE}. Null when none was. */
export function coverVerdict(shares: readonly (number | null)[]): Exclude<ReviewBehind["verdict"], "unplaced"> | null {
  const measured = shares.filter((share): share is number => share !== null);
  if (measured.length === 0) return null;
  const worst = measured.reduce((a, b) => (offFine(b) > offFine(a) ? b : a));
  if (worst < BEHIND_FLOATS) return "floats";
  if (worst > BEHIND_EATEN) return "eaten";
  return offFine(worst) > 0 ? "near" : "fine";
}

const percent = (share: number) => `${Math.round(share * 100)} %`;
const round = (value: number) => Math.round(value * 1000) / 1000;
const target = `${Math.round(BEHIND_FINE[0] * 100)} to ${Math.round(BEHIND_FINE[1] * 100)} %`;

/**
 * The entry of a word measured at `samples` (none unplaced): its verdict and the message that explains it. `from`/`to`:
 * its time behind the person, timeline seconds.
 */
export function behindEntry(word: { clip: string; track: string; plate: string }, from: number, to: number, samples: readonly ReviewBehindSample[]): ReviewBehind {
  const verdict = coverVerdict(samples.map((sample) => sample.covered));
  const base = { ...word, from: round(from), to: round(to), samples: [...samples] };
  if (verdict === null) return { ...base, verdict: "unplaced", message: `clip ${word.clip} draws nothing (its alpha is empty) at the frames measured.` };
  const shown = samples.filter((sample) => sample.covered !== null);
  const read = `the person covers ${shown.map((sample) => percent(sample.covered!)).join(", ")} of it at ${shown.map((sample) => `${sample.at} s`).join(", ")}`;
  const message =
    verdict === "fine"
      ? `${read}: within the ${target} that reads best.`
      : verdict === "near"
        ? `${read}: a little outside the ${target} that reads best; fine to keep, or nudge it ${shown.some((sample) => sample.covered! < BEHIND_FINE[0]) ? "toward the person" : "away from the person"}.`
        : verdict === "floats"
          ? `${read}: under ${percent(BEHIND_FLOATS)} the word floats beside the person instead of sitting behind them. Aim for ${target}: move it toward the person or make it larger (the template's \`place\` and \`size\`, or the clip's \`transform\`).`
          : `${read}: over ${percent(BEHIND_EATEN)} the person eats the word and it no longer reads. Aim for ${target}: move it out from behind them or make it larger.`;
  const straddles = shown.some((sample) => sample.covered! < BEHIND_FLOATS) && shown.some((sample) => sample.covered! > BEHIND_EATEN);
  return { ...base, verdict, message: straddles ? `${message} The samples fall on both sides of the band: part of the word floats, part is eaten.` : message };
}

/** Craft warnings of `entries`: a word covered out of the bands, and a word that meets a face. */
export function behindWarnings(entries: readonly ReviewBehind[]): ReviewFinding[] {
  const found: ReviewFinding[] = [];
  for (const entry of entries) {
    if (entry.verdict === "floats" || entry.verdict === "eaten") {
      found.push({ check: "behind", clip: entry.clip, from: entry.from, to: entry.to, message: `the word of clip ${entry.clip}, behind the person on plate track ${entry.plate}: ${entry.message}` });
    }
    const faces = entry.samples.filter((sample) => sample.face === true);
    if (faces.length > 0) {
      const at = faces.map((sample) => `${sample.at} s`).join(", ");
      found.push({
        check: "behind",
        clip: entry.clip,
        from: faces[0]!.at,
        to: faces.at(-1)!.at,
        message: `the word of clip ${entry.clip} meets a face of plate clip ${faces[0]!.plateClip} at ${at}: a word behind the head must stay clear of the face (where the matte misses, it shows over it). Move or shrink it.`,
      });
    }
  }
  return found;
}
