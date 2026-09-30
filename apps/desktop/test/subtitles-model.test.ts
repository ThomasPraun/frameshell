import type { Timeline, Transcript } from "@frameshell/schema";
import { subtitleTracks } from "@frameshell/schema/subtitles";
import { describe, expect, it } from "vitest";
import { cueBoxAt, cueBoxes, cueSelection, drawSubtitleLines, subtitleLines } from "../src/renderer/src/subtitles/model.js";

// Seams under test: what the preview draws for a frame (lines, runs, colours) and what a cue on a subtitle lane
// selects, from the cues export burns.

const transcript: Transcript = {
  schemaVersion: 1,
  asset: "assets/take.mp4",
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  words: [
    { id: "w_000001", text: "hola", start: 1.0, end: 1.3 },
    { id: "w_000002", text: "mundo", start: 1.4, end: 1.8 },
  ],
  edits: {},
};

function timeline(style: { preset?: string; position?: "top" | "center" | "bottom" }): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/take.mp4", start: 2, in: 1, out: 2 }] },
      { id: "s1", kind: "subtitles", follows: "v1", style },
    ],
  };
}
const tracks = (style: Parameters<typeof timeline>[0] = { preset: "big-keyword" }) => subtitleTracks(timeline(style), (asset) => (asset === transcript.asset ? transcript : null), 30);
/** Fake `measureText`: 10 px per character. */
const measure = (text: string) => text.length * 10;
const SIZE = { width: 960, height: 540 };

describe("preview subtitle lines", () => {
  it("center the cue on the frame and colour the word being spoken", () => {
    // "hola" plays 2.0-2.3 s (frames 60-69), "mundo" 2.4-2.8 s (frames 72-84).
    const [line] = subtitleLines(tracks(), 65, SIZE, measure);
    expect(line).toMatchObject({ track: "s1", text: "HOLA MUNDO", left: 480 - 50, font: '35px "Archivo Black"', active: "HOLA" });
    expect(line!.runs).toEqual([
      { text: "HOLA", color: "#ffd426", x: 430 },
      { text: "MUNDO", color: "#ffffff", x: 480 },
    ]);
    // Between the words the one spoken last stays highlighted; then the next one takes over.
    expect(subtitleLines(tracks(), 70, SIZE, measure)[0]!.active).toBe("HOLA");
    expect(subtitleLines(tracks(), 72, SIZE, measure)[0]!.active).toBe("MUNDO");
    expect(subtitleLines(tracks(), 59, SIZE, measure)).toEqual([]);
    expect(subtitleLines(tracks(), 84, SIZE, measure)).toEqual([]);
  });

  it("follow the track's position and preset: plain has no highlight and keeps the case", () => {
    const bottom = subtitleLines(tracks(), 65, SIZE, measure)[0]!.baseline;
    const [top] = subtitleLines(tracks({ preset: "plain", position: "top" }), 65, SIZE, measure);
    expect(top).toMatchObject({ text: "hola mundo", active: null });
    expect(top!.runs.every((run) => run.color === "#ffffff")).toBe(true);
    expect(top!.baseline).toBeLessThan(bottom / 3);
  });

  it("draw the whole line's outline first, then each run's fill over it", () => {
    const calls: string[] = [];
    const ctx = {
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      textBaseline: "",
      textAlign: "",
      strokeText: (text: string, x: number) => void calls.push(`stroke ${text} ${x} ${ctx.lineWidth}`),
      fillText: (text: string, x: number) => void calls.push(`fill ${text} ${x} ${String(ctx.fillStyle)}`),
    };
    drawSubtitleLines(ctx, subtitleLines(tracks(), 65, SIZE, measure));
    // Outline 0.09 of 35 px = 3.15 px around each glyph: a 6.3 px stroke.
    expect(calls).toEqual(["stroke HOLA MUNDO 430 6.3", "fill HOLA 430 #ffd426", "fill MUNDO 480 #ffffff"]);
    expect(ctx).toMatchObject({ lineJoin: "round", textBaseline: "alphabetic" });
  });
});

describe("subtitle lane cues", () => {
  it("are boxes in timeline seconds; a cue selects its words with their transcript and range", () => {
    const [track] = tracks();
    const boxes = cueBoxes(track!, 30);
    expect(boxes.map((box) => [box.start, box.end, box.text])).toEqual([[2, 2.8, "HOLA MUNDO"]]);
    expect(cueBoxAt(boxes, 2.5)).toBe(boxes[0]);
    expect(cueBoxAt(boxes, 2.8)).toBeNull();
    const picked = cueSelection(boxes[0]!.cue, 30, (asset) => (asset === "assets/take.mp4" ? "transcripts/take.words.json" : null));
    expect(picked).toEqual({
      words: [
        { transcript: "transcripts/take.words.json", asset: "assets/take.mp4", word: "w_000001", text: "HOLA", start: 1.0, end: 1.3 },
        { transcript: "transcripts/take.words.json", asset: "assets/take.mp4", word: "w_000002", text: "MUNDO", start: 1.4, end: 1.8 },
      ],
      range: { from: 2, to: 2.8 },
    });
    expect(cueSelection(boxes[0]!.cue, 30, () => null).words).toEqual([]);
  });
});
