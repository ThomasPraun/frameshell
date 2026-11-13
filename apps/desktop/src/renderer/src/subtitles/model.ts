// Subtitle tracks in the app (SPEC §3.4, §10): cue boxes for the timeline lanes, selections from them, and the lines
// the preview draws. Cues come from `@frameshell/schema/subtitles`, the definition export burns.
import type { Size } from "@frameshell/schema/composite";
import {
  type ResolvedSubtitleTrack,
  SUBTITLE_ENTRY,
  type SubtitleCue,
  type SubtitleStyle,
  cueTokens,
  entryEnd,
  entryProgress,
  entryUnits,
  subtitleAt,
  subtitleLayout,
} from "@frameshell/schema/subtitles";
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
  return track.cues.map((cue) => ({ start: cue.start / fps, end: cue.end / fps, text: cueTokens(cue).join(" "), cue }));
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
  /** While the run enters (`entry` of the cue): opacity 0-1. Absent when settled. */
  alpha?: number;
  /** While it enters: blur radius, px. */
  blur?: number;
  /** While it enters and its size differs from the line's (the keyword settling): its CSS font. */
  font?: string;
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
  /** True while the cue enters: runs are drawn one by one with their own opacity and blur. */
  entering?: true;
}

/**
 * Lines showing at timeline `frame` in a `frame`-sized picture, one per
 * subtitle track with a cue then, in track order (later ones on top): laid
 * out with export's `subtitleLayout`, centered with `measure` (canvas
 * `measureText` width), the word being spoken in the highlight colour and
 * a phrase's keyword in the keyword colour. While a cue enters (its `entry`)
 * the runs are its units (characters in `chars`) at the progress export's
 * `\t` tags give them; the keyword's scale is drawn about its own centre,
 * while export's glyph scaling also nudges its neighbours.
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
    const font = `${layout.fontSize}px ${cssFamily(style)}`;
    const texts = cueTokens(shown.cue);
    const lead = texts.length - shown.cue.words.length;
    const text = texts.join(" ");
    const left = layout.centerX - measure(text, font) / 2;
    const keyword = shown.cue.keyword === undefined ? -1 : shown.cue.keyword + lead;
    const tint = (token: number) =>
      token === keyword && style.keywordColor !== null
        ? style.keywordColor
        : token === shown.active + lead && style.highlight
          ? style.highlight
          : style.color;
    const elapsed = (frame - shown.cue.start) / track.fps;
    const entering = shown.cue.entry !== "none" && elapsed < entryEnd(shown.cue, track.fps);
    const runs: SubtitleRun[] = entering
      ? enteringRuns(shown.cue, track.fps, elapsed, texts, { font, fontSize: layout.fontSize, left, measure, tint, style })
      : texts.map((word, i) => ({
          text: word,
          color: tint(i),
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
      active: shown.active >= 0 && style.highlight ? texts[shown.active + lead]! : null,
      ...(entering ? { entering: true as const } : {}),
    });
  }
  return lines;
}

/** One run per entry unit of `cue`, `elapsed` seconds in. */
function enteringRuns(
  cue: SubtitleCue,
  fps: number,
  elapsed: number,
  tokens: readonly string[],
  at: {
    font: string;
    fontSize: number;
    left: number;
    measure: (text: string, font: string) => number;
    tint: (token: number) => string;
    style: SubtitleStyle;
  },
): SubtitleRun[] {
  const { font, fontSize, left, measure, tint, style } = at;
  const starts: number[] = [];
  let offset = 0;
  for (const token of tokens) {
    starts.push(offset);
    offset += token.length + 1;
  }
  const taken = new Map<number, number>();
  return entryUnits(cue, fps).map((unit) => {
    const inside = taken.get(unit.token) ?? 0;
    taken.set(unit.token, inside + unit.text.length);
    const before = starts[unit.token]! + inside;
    const x = left + (before === 0 ? 0 : measure(tokens.join(" ").slice(0, before), font));
    const progress = entryProgress(elapsed, unit.delay);
    const run: SubtitleRun = { text: unit.text, color: tint(unit.token), x };
    if (progress >= 1) return run;
    run.alpha = progress;
    run.blur = round2(fontSize * SUBTITLE_ENTRY.blur * (1 - progress));
    const grow = unit.keyword ? 1 + (style.keywordScale - 1) * (1 - progress) : 1;
    if (grow !== 1) {
      run.font = `${round2(fontSize * grow)}px ${cssFamily(style)}`;
      run.x = x - (measure(unit.text, font) * (grow - 1)) / 2;
    }
    return run;
  });
}

/** The style's face as a quoted CSS family. */
function cssFamily(style: SubtitleStyle): string {
  return `"${style.font.family.replace(/["\\]/g, "")}"`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
  /** Opacity of what is drawn next; set only while a cue enters. */
  globalAlpha?: number;
  /** CSS filter of what is drawn next (`blur(2px)`); set only while a cue enters. */
  filter?: string;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

/**
 * Draw `lines` like libass does: the whole line's outline first (round
 * joins, `outline` px around each glyph), then each run's fill over it.
 * A line whose cue is entering is drawn run by run, every outline before
 * every fill, each with its own opacity and blur.
 */
export function drawSubtitleLines(ctx: SubtitleCanvas, lines: readonly SubtitleLine[]): void {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  for (const line of lines) {
    ctx.font = line.font;
    if (line.entering) {
      drawEntering(ctx, line);
      continue;
    }
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

function drawEntering(ctx: SubtitleCanvas, line: SubtitleLine): void {
  const settle = () => {
    ctx.globalAlpha = 1;
    ctx.filter = "none";
  };
  for (const pass of ["stroke", "fill"] as const) {
    if (pass === "stroke" && line.outline <= 0) continue;
    ctx.lineWidth = line.outline * 2;
    ctx.strokeStyle = line.outlineColor;
    for (const run of line.runs) {
      ctx.font = run.font ?? line.font;
      ctx.globalAlpha = run.alpha ?? 1;
      ctx.filter = run.blur ? `blur(${run.blur}px)` : "none";
      if (pass === "stroke") {
        ctx.strokeText(run.text, run.x, line.baseline);
      } else {
        ctx.fillStyle = run.color;
        ctx.fillText(run.text, run.x, line.baseline);
      }
    }
  }
  settle();
}
