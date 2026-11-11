import { describe, expect, it } from "vitest";
import { type Timeline, type Transcript, subtitleTracks } from "@frameshell/schema";
import { assSubtitles } from "../src/index.js";

const transcript: Transcript = {
  schemaVersion: 1,
  asset: "assets/talk.mp4",
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  speakers: [{ id: "s1", name: "Juan" }],
  words: [
    { id: "w_000001", text: "hola", start: 0, end: 0.4, speaker: "s1" },
    { id: "w_000002", text: "amigos", start: 0.5, end: 0.9, speaker: "s1" },
  ],
  edits: {},
};

function ass(style: Record<string, unknown>): string {
  const timeline: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: transcript.asset, start: 0, in: 0, out: 2 }] },
      { id: "s1", kind: "subtitles", follows: "v1", style },
    ],
  };
  return assSubtitles(subtitleTracks(timeline, () => transcript, 30), { width: 1920, height: 1080 }, 30);
}
const dialogues = (script: string) => script.split("\n").filter((line) => line.startsWith("Dialogue"));

describe("ASS speaker names (ADR 0020)", () => {
  it("are not written unless the style asks, and speakerNames false is the same file", () => {
    const off = ass({ preset: "big-keyword" });
    expect(off).not.toContain("JUAN");
    expect(ass({ preset: "big-keyword", speakerNames: false })).toBe(off);
  });

  it("prefix the first cue and keep the highlight on the spoken word", () => {
    const lines = dialogues(ass({ preset: "big-keyword", speakerNames: true }));
    expect(lines.map((line) => line.split(",,").at(-1))).toEqual([
      "{\\an2\\pos(960,950.4)}JUAN: {\\c&H0026D4FF&}HOLA{\\c&H00FFFFFF&} AMIGOS",
      "{\\an2\\pos(960,950.4)}JUAN: HOLA {\\c&H0026D4FF&}AMIGOS{\\c&H00FFFFFF&}",
    ]);
  });

  it("write the label on a plain event when nothing is highlighted", () => {
    expect(dialogues(ass({ preset: "plain", speakerNames: true }))[0]).toMatch(/\}Juan: hola amigos$/);
  });
});

describe("ASS hand-chunked captions (#460)", () => {
  const phrases = [{ asset: transcript.asset, words: ["w_000001", "w_000002"], chunks: [2], keyword: 1 }];
  const withPhrases = (style: Record<string, unknown>) => {
    const timeline: Timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: transcript.asset, start: 0, in: 0, out: 2 }] },
        { id: "s1", kind: "subtitles", follows: "v1", style, phrases },
      ],
    };
    return dialogues(assSubtitles(subtitleTracks(timeline, () => transcript, 30), { width: 1920, height: 1080 }, 30));
  };
  const texts = (lines: string[]) => lines.map((line) => line.split(",,").at(-1));

  it("colour the keyword for the whole cue, ahead of the spoken highlight", () => {
    expect(texts(withPhrases({ preset: "plain", keywordColor: "#ff0000" }))).toEqual(["{\\an2\\pos(960,1015.198)}hola {\\c&H000000FF&}amigos{\\c&H00FFFFFF&}"]);
    expect(texts(withPhrases({ preset: "big-keyword", keywordColor: "#00ff00" }))).toEqual([
      "{\\an2\\pos(960,950.4)}{\\c&H0026D4FF&}HOLA{\\c&H00FFFFFF&} {\\c&H0000FF00&}AMIGOS{\\c&H00FFFFFF&}",
      "{\\an2\\pos(960,950.4)}HOLA {\\c&H0000FF00&}AMIGOS{\\c&H00FFFFFF&}",
    ]);
  });

  it("write no colour for a keyword when the style has none", () => {
    expect(texts(withPhrases({ preset: "plain", keywordColor: null }))).toEqual(["{\\an2\\pos(960,1015.198)}hola amigos"]);
  });

  it("fade a line in with one transform over 0.4 s, the keyword settling from its scale", () => {
    expect(texts(withPhrases({ preset: "plain", entry: "line" }))).toEqual([
      "{\\an2\\pos(960,1015.198)}{\\alpha&HFF&\\blur3.92\\t(0,400,0.5,\\alpha&H00&\\blur0)}hola{\\alpha&H00&\\blur0} " +
        "{\\c&H0026D4FF&\\alpha&HFF&\\blur3.92\\fscx112\\fscy112\\t(0,400,0.5,\\alpha&H00&\\blur0\\fscx100\\fscy100)}amigos{\\c&H00FFFFFF&\\alpha&H00&\\blur0\\fscx100\\fscy100}",
    ]);
  });

  it("start each word at its spoken time; an event that starts at that time begins its entry at once", () => {
    const [first, second] = texts(withPhrases({ entry: "words" }));
    expect(first).toContain("\\t(500,900,0.5,");
    expect(second).toContain("}HOLA {");
    expect(second).toContain("\\t(0,400,0.5,");
  });

  it("stagger characters by 30 ms", () => {
    const [line] = texts(withPhrases({ preset: "plain", entry: "chars" }));
    expect(line).toContain("\\t(0,400,0.5,\\alpha&H00&\\blur0)}h");
    expect(line).toContain("\\t(30,430,0.5,\\alpha&H00&\\blur0)}o");
  });
});
