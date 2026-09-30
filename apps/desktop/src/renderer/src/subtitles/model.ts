// Subtitle tracks in the app (SPEC §3.4, §10): cue boxes for the timeline lanes, selections from them, and the lines
// the preview draws. Cues come from `@frameshell/schema/subtitles`, the definition export burns.
import type { Size } from "@frameshell/schema/composite";
import { type ResolvedSubtitleTrack, SUBTITLE_FONT, type SubtitleCue, subtitleAt, subtitleLayout } from "@frameshell/schema/subtitles";
import type { SelectedWord, TimeRange } from "../selection.js";

/** One cue on a subtitle lane, timeline seconds. */
export interface CueBox {
  start: number;
  end: number;
  /** Words as displayed, space separated. */
  text: string;
  cue: SubtitleCue;
}

/** Cue boxes of a track, sorted by start. */
export function cueBoxes(track: ResolvedSubtitleTrack, fps: number): CueBox[] {
  return track.cues.map((cue) => ({ start: cue.start / fps, end: cue.end / fps, text: cue.words.map((word) => word.text).join(" "), cue }));
}

/** Cue box under timeline second `time`; null between cues. */
export function cueBoxAt(boxes: readonly CueBox[], time: number): CueBox | null {
  return boxes.find((box) => time >= box.start && time < box.end) ?? null;
}

/**
 * The words of `cue` as a selection: each word with its transcript
 * (`transcriptOf` its asset), and the cue's timeline range. Words whose
 * transcript is unknown are left out.
 */
export function cueSelection(cue: SubtitleCue, fps: number, transcriptOf: (asset: string) => string | null): { words: SelectedWord[]; range: TimeRange } {
  const words = cue.words.flatMap((word): SelectedWord[] => {
    const transcript = transcriptOf(word.asset);
    return transcript ? [{ transcript, asset: word.asset, word: word.id, text: word.text, start: word.sourceStart, end: word.sourceEnd }] : [];
  });
  return { words, range: { from: cue.start / fps, to: cue.end / fps } };
}

/** A run of one colour in a subtitle line. */
export interface SubtitleRun {
  text: string;
  color: string;
  /** Left edge, px. */
  x: number;
}

/** One line to draw over the picture, px of a `frame`-sized canvas. */
export interface SubtitleLine {
  track: string;
  /** CSS font shorthand. */
  font: string;
  text: string;
  /** Left edge of the whole line. */
  left: number;
  baseline: number;
  /** Outline width around each glyph (canvas stroke width is twice it). */
  outline: number;
  outlineColor: string;
  runs: SubtitleRun[];
  /** Text of the highlighted word; null when none. */
  active: string | null;
}

/**
 * Lines showing at timeline `frame` in a `frame`-sized picture, one per
 * subtitle track with a cue then, in track order (later ones on top): laid
 * out with export's `subtitleLayout`, centered with `measure` (canvas
 * `measureText` width), the word being spoken in the highlight colour.
 */
export function subtitleLines(
  tracks: readonly ResolvedSubtitleTrack[],
  frame: number,
  size: Size,
  measure: (text: string, font: string) => number,
): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  for (const track of tracks) {
    const shown = subtitleAt(track.cues, frame);
    if (!shown) continue;
    const { style } = track;
    const layout = subtitleLayout(style, size);
    const font = `${layout.fontSize}px "${SUBTITLE_FONT.family}"`;
    const texts = shown.cue.words.map((word) => word.text);
    const text = texts.join(" ");
    const left = layout.centerX - measure(text, font) / 2;
    const runs = texts.map((word, i) => ({
      text: word,
      color: i === shown.active && style.highlight ? style.highlight : style.color,
      x: left + (i === 0 ? 0 : measure(`${texts.slice(0, i).join(" ")} `, font)),
    }));
    lines.push({
      track: track.track,
      font,
      text,
      left,
      baseline: layout.baseline,
      outline: layout.outline,
      outlineColor: style.outlineColor,
      runs,
      active: shown.active >= 0 && style.highlight ? texts[shown.active]! : null,
    });
  }
  return lines;
}

/** The slice of `CanvasRenderingContext2D` {@link drawSubtitleLines} uses. */
export interface SubtitleCanvas {
  font: string;
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  textBaseline: string;
  textAlign: string;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

/**
 * Draw `lines` like libass does: the whole line's outline first (round
 * joins, `outline` px around each glyph), then each run's fill over it.
 */
export function drawSubtitleLines(ctx: SubtitleCanvas, lines: readonly SubtitleLine[]): void {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  for (const line of lines) {
    ctx.font = line.font;
    if (line.outline > 0) {
      ctx.lineWidth = line.outline * 2;
      ctx.strokeStyle = line.outlineColor;
      ctx.strokeText(line.text, line.left, line.baseline);
    }
    for (const run of line.runs) {
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, run.x, line.baseline);
    }
  }
}
