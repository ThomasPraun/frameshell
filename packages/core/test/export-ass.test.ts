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
