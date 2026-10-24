import { parseShootScript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type PromptStream,
  type StopBox,
  focusOffset,
  fontSize,
  glide,
  positionOf,
  promptStream,
  stepLine,
  stepWord,
  stopOf,
} from "../src/renderer/src/teleprompter/model.js";
import { teleprompter } from "../src/renderer/src/teleprompter/store.js";

// Seam under test: the teleprompter's script stream, its moves and the focus-line scroll (#392, ADR 0024).

const SCRIPT = `---
shoot: true
---
## Hook (0:00–0:05)
**Ana:** ¿Listos? Hoy grabamos. [VISUAL: logo] Empieza ya.
**Ben:** Sí.

## Story
[FREE: how we met]
[VISUAL: b-roll only]
**Ana:** One more line [PAUSE] here!
`;

const stream = promptStream(parseShootScript(SCRIPT));
const texts = (from: PromptStream) => from.stops.map(({ text }) => text);

describe("teleprompter stream", () => {
  it("lays every word out in reading order with the punctuation the script writes", () => {
    expect(texts(stream)).toEqual(["¿Listos?", "Hoy", "grabamos.", "Empieza", "ya.", "Sí.", "how we met", "One", "more", "line", "here!"]);
    expect(stream.scenes.map(({ slug, start, end }) => [slug, start, end])).toEqual([
      ["hook", 0, 6],
      ["story", 6, 11],
    ]);
  });

  it("ends a sentence at . ! ? and at the end of a line", () => {
    expect(stream.sentences.map(({ start, end }) => texts(stream).slice(start, end).join(" "))).toEqual([
      "¿Listos?",
      "Hoy grabamos.",
      "Empieza ya.",
      "Sí.",
      "how we met",
      "One more line here!",
    ]);
  });

  it("keeps speakers per line (a name holds until the next) and cues before the stop they precede", () => {
    expect(stream.lines.map(({ speaker, fileLine }) => [fileLine, speaker])).toEqual([
      [5, "Ana"],
      [6, "Ben"],
      [9, "Ben"],
      [10, "Ben"],
      [11, "Ana"],
    ]);
    expect(stream.lines[0]!.cues).toEqual([{ label: "VISUAL", text: "logo", free: false, before: 3 }]);
    // A FREE slot on a line without words is a stop of its own; a line of other cues has none.
    expect(stream.stops[6]).toMatchObject({ kind: "free", text: "how we met", word: 0 });
    expect(stream.lines[3]).toMatchObject({ start: 7, end: 7, cues: [{ label: "VISUAL", text: "b-roll only", before: 7 }] });
    expect(stream.lines[4]!.cues).toEqual([{ label: "PAUSE", text: null, free: false, before: 10 }]);
  });
});

describe("teleprompter moves", () => {
  it("moves by word inside the stream", () => {
    expect(stepWord(stream, 0, -1)).toBe(0);
    expect(stepWord(stream, 4, 1)).toBe(5);
    expect(stepWord(stream, 10, 3)).toBe(10);
    expect(stepWord(promptStream({ scenes: [] }), 0, 1)).toBe(-1);
  });

  it("moves by line to a line's start, skipping lines with no stops; back from mid-line restarts the line", () => {
    expect(stepLine(stream, 2, 1)).toBe(5);
    expect(stepLine(stream, 6, 1)).toBe(7);
    expect(stepLine(stream, 7, -1)).toBe(6);
    expect(stepLine(stream, 9, -1)).toBe(7);
    expect(stepLine(stream, 9, -2)).toBe(6);
    expect(stepLine(stream, 0, -1)).toBe(0);
    expect(stepLine(stream, 8, 5)).toBe(7);
  });

  it("turns positions into stops and back", () => {
    for (let stop = 0; stop < stream.stops.length; stop++) expect(stopOf(stream, positionOf(stream, stop)!)).toBe(stop);
    expect(positionOf(stream, 4)).toEqual({ scene: "hook", line: 5, word: 4 });
    expect(stopOf(stream, { scene: "story", line: null, word: 0 })).toBe(6);
    // A line of cues only falls to the next stop, a word past the line to its last, an unknown scene to none.
    expect(stopOf(stream, { scene: "story", line: 10, word: 0 })).toBe(7);
    expect(stopOf(stream, { scene: "hook", line: 6, word: 9 })).toBe(5);
    expect(stopOf(stream, { scene: "hook", line: 99, word: 0 })).toBe(5);
    expect(stopOf(stream, { scene: "outro", line: null, word: 0 })).toBe(-1);
    expect(positionOf(stream, 99)).toBeNull();
  });
});

/** Words of one line, `size` px wide each, wrapped `perRow` to a row of `pitch` px. */
function rowsOf(count: number, perRow: number, { size = 100, height = 40, pitch = 60, top = 0 } = {}): StopBox[] {
  return Array.from({ length: count }, (_, index) => ({
    top: top + Math.floor(index / perRow) * pitch,
    left: (index % perRow) * size,
    width: size - 10,
    height,
  }));
}

describe("teleprompter focus line", () => {
  // One line of 12 words, three rows of four; one sentence.
  const long = promptStream(parseShootScript("---\nshoot: true\n---\n## A\none two three four five six seven eight nine ten eleven twelve\n"));
  const boxes = rowsOf(12, 4);
  const view = { height: 600, focus: 300, margin: 20 };

  it("keeps the current word's row on the focus line, within half a row", () => {
    for (let stop = 0; stop < 12; stop++) {
      const center = boxes[stop]!.top + boxes[stop]!.height / 2;
      expect(Math.abs(focusOffset(long, boxes, stop, view) - center)).toBeLessThanOrEqual(30);
    }
  });

  it("moves forward with every word of a line, never back, so the text glides instead of jumping a row", () => {
    const offsets = boxes.map((_, stop) => focusOffset(long, boxes, stop, view));
    for (let stop = 1; stop < offsets.length; stop++) expect(offsets[stop]).toBeGreaterThan(offsets[stop - 1]!);
    // From the last word of a row to the first of the next, it moves no more than between two words of a row.
    const within = offsets[1]! - offsets[0]!;
    expect(offsets[4]! - offsets[3]!).toBeLessThanOrEqual(within + 1);
  });

  it("keeps a sentence that fits whole on screen, even when its start is far above the focus line", () => {
    const small = { height: 200, focus: 100, margin: 10 };
    // Three rows (0..160) fit in 200 - 2 * 10; the word on the last row would push the first row off the top.
    const offset = focusOffset(long, boxes, 11, small);
    expect(0 - offset + small.focus).toBeGreaterThanOrEqual(small.margin);
    expect(160 - offset + small.focus).toBeLessThanOrEqual(small.height - small.margin);
    // Taller than the view: the current word wins.
    const tiny = { height: 120, focus: 60, margin: 10 };
    expect(Math.abs(focusOffset(long, boxes, 11, tiny) - (boxes[11]!.top + 20))).toBeLessThanOrEqual(30);
  });

  it("puts a word alone on its row exactly on the focus line", () => {
    const single = rowsOf(1, 1, { top: 500 });
    const one = promptStream(parseShootScript("---\nshoot: true\n---\n## A\nHello\n"));
    expect(focusOffset(one, single, 0, view)).toBe(520);
  });

  it("glides toward the target without overshoot and lands on it", () => {
    let shown = 0;
    const seen: number[] = [];
    for (let frame = 0; frame < 120 && shown !== 300; frame++) seen.push((shown = glide(shown, 300, 16)));
    expect(shown).toBe(300);
    for (let index = 1; index < seen.length; index++) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]!);
    expect(Math.max(...seen)).toBe(300);
    expect(glide(300, 300, 16)).toBe(300);
  });
});

describe("teleprompter settings", () => {
  it("keeps font sizes on the offered steps", () => {
    expect(fontSize(45)).toBe(44);
    expect(fontSize(1)).toBe(20);
    expect(fontSize(999)).toBe(120);
    expect(fontSize("big")).toBe(44);
  });
});

describe("teleprompter store", () => {
  it("is moved by keys always and by drivers unless held; a new script starts without a position", () => {
    let changes = 0;
    const off = teleprompter.subscribe(() => changes++);
    teleprompter.setScript("scripts/a.md");
    expect(teleprompter.setPosition({ scene: "hook", line: 5, word: 1 }, "follow")).toBe(true);
    teleprompter.setHeld(true);
    expect(teleprompter.setPosition({ scene: "hook", line: 5, word: 2 }, "follow")).toBe(false);
    expect(teleprompter.get().position).toEqual({ scene: "hook", line: 5, word: 1 });
    expect(teleprompter.setPosition({ scene: "hook", line: 5, word: 3 })).toBe(true);
    expect(teleprompter.get().position?.word).toBe(3);
    teleprompter.setScript("scripts/b.md");
    expect(teleprompter.get()).toMatchObject({ script: "scripts/b.md", position: null, held: true });
    expect(changes).toBe(5);
    off();
  });
});
