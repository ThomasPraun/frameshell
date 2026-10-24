// Pure teleprompter model (ADR 0024 decision 6): a shoot script as one flat stream of stops, moves by word and line,
// and the scroll offset that keeps the current stop on the focus line.
import type { ShootScript } from "@frameshell/schema";

/** A cue as the teleprompter shows it, placed before the stop at `before` (the line's `end` when it closes the line). */
export interface PromptCue {
  label: string;
  text: string | null;
  free: boolean;
  before: number;
}

/** One place the reader can be: a spoken word, or a `[FREE: …]` slot on a line that has no words. */
export interface PromptStop {
  kind: "word" | "free";
  /** A word with the punctuation around it, as the script writes it; a slot's note (its label without one). */
  text: string;
  /** Index in {@link PromptStream.lines}. */
  line: number;
  /** Index in {@link PromptStream.sentences}. */
  sentence: number;
  /** Index in the shoot line's `words`; 0 for a slot. */
  word: number;
}

/** One shoot line: its stops are `[start, end)` of {@link PromptStream.stops}, empty for a line of non-FREE cues only. */
export interface PromptLine {
  /** Index in {@link PromptStream.scenes}. */
  scene: number;
  /** 1-based file line, as `ShootLine.line`. */
  fileLine: number;
  speaker: string | null;
  start: number;
  end: number;
  /** Cues shown in the line, in order; a slot's own FREE cue is its stop instead. */
  cues: PromptCue[];
}

/** A sentence: stops `[start, end)`, all on one line. */
export interface PromptSentence {
  line: number;
  start: number;
  end: number;
}

/** A scene: its lines `[firstLine, endLine)` and stops `[start, end)`. */
export interface PromptScene {
  slug: string;
  title: string;
  firstLine: number;
  endLine: number;
  start: number;
  end: number;
}

/** A shoot script laid flat for the teleprompter, built by {@link promptStream}. */
export interface PromptStream {
  scenes: PromptScene[];
  lines: PromptLine[];
  sentences: PromptSentence[];
  stops: PromptStop[];
}

/** Where the reader is, in script terms: what the position store keeps and other views read or set. */
export interface PromptPosition {
  /** Scene slug. */
  scene: string;
  /** 1-based file line; null for the scene's first stop. */
  line: number | null;
  /** Index in the line's `words`; 0 for a slot. */
  word: number;
}

/** Punctuation that ends a sentence when it follows a word. */
const SENTENCE_END = /[.!?…。！？]/;

/**
 * The stops of `script` in reading order. Each word keeps the punctuation the script writes around it (`text`
 * holds it, `words` does not), and a sentence ends at a word followed by `.`, `!`, `?` or `…`, or at the end of
 * its line. A line with no words but a `[FREE: …]` cue is one stop per FREE cue, so the reader can rest on it.
 */
export function promptStream(script: Pick<ShootScript, "scenes">): PromptStream {
  const stream: PromptStream = { scenes: [], lines: [], sentences: [], stops: [] };
  for (const scene of script.scenes) {
    const sceneIndex = stream.scenes.length;
    const promptScene: PromptScene = { slug: scene.slug, title: scene.title, firstLine: stream.lines.length, endLine: 0, start: stream.stops.length, end: 0 };
    stream.scenes.push(promptScene);
    for (const line of scene.lines) {
      const lineIndex = stream.lines.length;
      const start = stream.stops.length;
      const cues: PromptCue[] = [];
      if (line.words.length === 0) {
        for (const cue of line.cues) {
          if (!cue.free) {
            cues.push({ label: cue.label, text: cue.text, free: false, before: stream.stops.length });
            continue;
          }
          stream.sentences.push({ line: lineIndex, start: stream.stops.length, end: stream.stops.length + 1 });
          stream.stops.push({ kind: "free", text: cue.text ?? cue.label, line: lineIndex, sentence: stream.sentences.length - 1, word: 0 });
        }
      } else {
        const texts = wordTexts(line.text, line.words);
        let sentenceStart = start;
        line.words.forEach((_, word) => {
          stream.stops.push({ kind: "word", text: texts[word]!.text, line: lineIndex, sentence: stream.sentences.length, word });
          if (texts[word]!.ends || word === line.words.length - 1) {
            stream.sentences.push({ line: lineIndex, start: sentenceStart, end: stream.stops.length });
            sentenceStart = stream.stops.length;
          }
        });
        for (const cue of line.cues) cues.push({ label: cue.label, text: cue.text, free: cue.free, before: start + cue.at });
      }
      stream.lines.push({ scene: sceneIndex, fileLine: line.line, speaker: line.speaker, start, end: stream.stops.length, cues });
    }
    promptScene.endLine = stream.lines.length;
    promptScene.end = stream.stops.length;
  }
  return stream;
}

/**
 * Each word's text with the punctuation around it, and whether a sentence ends after it. Words are substrings of
 * `text` in order (the parser takes both from the same segments), found left to right; text before the first word
 * (an opening `¿` or quote) goes with it, and the rest up to the next word with the word before.
 */
function wordTexts(text: string, words: readonly string[]): { text: string; ends: boolean }[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const at = text.indexOf(word, cursor);
    starts.push(at === -1 ? -1 : at);
    if (at !== -1) cursor = at + word.length;
  }
  if (starts.some((at) => at === -1)) return words.map((word) => ({ text: word, ends: false }));
  return words.map((word, index) => {
    const from = index === 0 ? 0 : starts[index]!;
    const to = index + 1 < words.length ? starts[index + 1]! : text.length;
    const after = text.slice(starts[index]! + word.length, to);
    return { text: text.slice(from, to).trim(), ends: SENTENCE_END.test(after) };
  });
}

/** Stop `delta` words from `stop`, kept inside the stream; -1 for an empty stream. */
export function stepWord(stream: PromptStream, stop: number, delta: number): number {
  if (stream.stops.length === 0) return -1;
  return clamp(stop + delta, 0, stream.stops.length - 1);
}

/**
 * Stop `delta` lines from `stop`: the first stop of that line, skipping lines with no stops. Going back from
 * inside a line first returns to its start, as a restart of the line needs; the stream's ends hold.
 */
export function stepLine(stream: PromptStream, stop: number, delta: number): number {
  const current = stream.stops[stop];
  if (!current) return stepWord(stream, stop, 0);
  let line = current.line;
  let left = Math.abs(delta);
  const direction = Math.sign(delta);
  if (direction < 0 && stream.lines[line]!.start < stop) left--;
  while (left > 0) {
    let next = line + direction;
    while (next >= 0 && next < stream.lines.length && stream.lines[next]!.start === stream.lines[next]!.end) next += direction;
    if (next < 0 || next >= stream.lines.length) break;
    line = next;
    left--;
  }
  return stream.lines[line]!.start;
}

/**
 * The stop of `position`; a line without stops falls to the next stop, a word past its line's end to the line's
 * last, a line past the scene's end to the scene's last stop. -1 when the scene is unknown or the stream empty.
 */
export function stopOf(stream: PromptStream, position: PromptPosition): number {
  const scene = stream.scenes.find(({ slug }) => slug === position.scene);
  if (!scene || stream.stops.length === 0) return -1;
  const last = stream.stops.length - 1;
  if (position.line === null) return Math.min(scene.start, last);
  for (let index = scene.firstLine; index < scene.endLine; index++) {
    const line = stream.lines[index]!;
    if (line.fileLine < position.line) continue;
    if (line.fileLine > position.line) return Math.min(line.start, last);
    if (line.start === line.end) continue;
    return line.start + clamp(position.word, 0, line.end - line.start - 1);
  }
  return Math.min(scene.end > scene.start ? scene.end - 1 : scene.start, last);
}

/** {@link PromptPosition} of `stop`; null when there is no such stop. */
export function positionOf(stream: PromptStream, stop: number): PromptPosition | null {
  const current = stream.stops[stop];
  if (!current) return null;
  const line = stream.lines[current.line]!;
  return { scene: stream.scenes[line.scene]!.slug, line: line.fileLine, word: current.word };
}

/** Top-left and size of a stop's box in the scrolled content, px (before any mirroring). */
export interface StopBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The panel's scroll viewport: its height, the focus line's distance from its top, and the room kept at its edges, px. */
export interface PromptView {
  height: number;
  focus: number;
  margin: number;
}

/**
 * Content y to put on the focus line for `current` (one box per stop). The current stop's row sits on the focus
 * line, moved along by how far into the row the stop is (half a row up at its end, half down at its start), so
 * reading a line moves the text up steadily rather than a row at a time: never backwards within a line. The
 * current sentence then stays whole on screen when it fits: kept off the top and bottom by `margin`.
 */
export function focusOffset(stream: PromptStream, boxes: readonly StopBox[], current: number, view: PromptView): number {
  const box = boxes[current];
  const stop = stream.stops[current];
  if (!box || !stop) return 0;
  const sameRow = (index: number) => stream.stops[index]?.line === stop.line && boxes[index] !== undefined && Math.abs(boxes[index]!.top - box.top) < box.height / 2;
  let first = current;
  while (sameRow(first - 1)) first--;
  let last = current;
  while (sameRow(last + 1)) last++;
  const left = boxes[first]!.left;
  const width = boxes[last]!.left + boxes[last]!.width - left;
  const fraction = width > 0 ? (box.left + box.width / 2 - left) / width : 0.5;
  const after = boxes[last + 1];
  const pitch = after && stream.stops[last + 1]!.line === stop.line && after.top > box.top ? after.top - box.top : box.height;
  let offset = box.top + box.height / 2 + (fraction - 0.5) * pitch;

  const sentence = stream.sentences[stop.sentence]!;
  const top = Math.min(...range(sentence.start, sentence.end).map((index) => boxes[index]?.top ?? box.top));
  const bottom = Math.max(...range(sentence.start, sentence.end).map((index) => (boxes[index] ? boxes[index]!.top + boxes[index]!.height : box.top + box.height)));
  if (bottom - top <= view.height - 2 * view.margin) {
    // The sentence's top no higher than `margin`, its bottom no lower than `height - margin`.
    offset = Math.min(offset, top - view.margin + view.focus);
    offset = Math.max(offset, bottom + view.margin + view.focus - view.height);
  }
  return offset;
}

/** Time constant of the scroll's glide toward its target, ms: about 95% of the way in three of them. */
export const GLIDE_MS = 120;

/** Scroll position `elapsed` ms after `shown`, gliding toward `target` without overshoot; exactly `target` once within half a pixel. */
export function glide(shown: number, target: number, elapsed: number, tau = GLIDE_MS): number {
  const next = target + (shown - target) * Math.exp(-Math.max(0, elapsed) / tau);
  return Math.abs(next - target) < 0.5 ? target : next;
}

/** Font sizes the panel offers, px. */
export const FONT_SIZES = { min: 20, max: 120, step: 4, initial: 44 } as const;

/** `size` as a font size the panel offers: a step of {@link FONT_SIZES} within its bounds; the initial size when not a number. */
export function fontSize(size: unknown): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return FONT_SIZES.initial;
  return clamp(Math.round(size / FONT_SIZES.step) * FONT_SIZES.step, FONT_SIZES.min, FONT_SIZES.max);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
