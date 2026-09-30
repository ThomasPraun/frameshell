import { describe, expect, it } from "vitest";
import {
  type Timeline,
  type Transcript,
  resolveSubtitleStyle,
  subtitleAt,
  subtitleCues,
  subtitleLayout,
  subtitleTracks,
  subtitleWords,
} from "../src/index.js";

const HASH = `sha256:${"0".repeat(64)}`;

/** Ten words, one every half second from 1 s, each 0.4 s long: w_000001 "uno" at 1.0-1.4 … w_000010 "diez" at 5.5-5.9. */
const NUMBERS = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];
const talk: Transcript = {
  schemaVersion: 1,
  asset: "assets/talk.mp4",
  assetHash: HASH,
  provider: "whisper-cpp",
  model: "m",
  words: NUMBERS.map((text, i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 })),
  edits: {},
};
const lookup = (asset: string) => (asset === talk.asset ? talk : null);

function timeline(clips: object[], extra: object[] = []): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: clips as never },
      { id: "s1", kind: "subtitles", follows: "v1" },
      ...(extra as never[]),
    ],
  };
}
const media = (id: string, start: number, inS: number, out: number, speed?: number) => ({
  id,
  type: "media",
  asset: "assets/talk.mp4",
  start,
  in: inS,
  out,
  ...(speed ? { speed } : {}),
});

describe("subtitle words (SPEC §5.3)", () => {
  it("are the transcript words inside the followed clip, on the timeline clock in frames", () => {
    // Source 2.0-4.0 plays from timeline 10 s: "tres" (2.0-2.4) at 10.0-10.4 = frames 300-312 at 30 fps.
    const words = subtitleWords(timeline([media("c1", 10, 2, 4)]), "s1", lookup, 30);
    expect(words.map((w) => [w.id, w.text, w.start, w.end, w.clip])).toEqual([
      ["w_000003", "tres", 300, 312, "c1"],
      ["w_000004", "cuatro", 315, 327, "c1"],
      ["w_000005", "cinco", 330, 342, "c1"],
      ["w_000006", "seis", 345, 357, "c1"],
    ]);
  });

  it("drop what a cut removed, with no extra edits: a word counts when its midpoint is kept", () => {
    // A cut from source 2.3 to 3.3 left two clips: "tres" (midpoint 2.2) stays, "cuatro" (2.7) and "cinco" (3.2) go.
    const cut = timeline([media("c1", 0, 1, 2.3), media("c2", 1.3, 3.3, 4)]);
    const words = subtitleWords(cut, "s1", lookup, 30);
    expect(words.map((w) => w.text)).toEqual(["uno", "dos", "tres", "seis"]);
    // "tres" is clipped at its clip's end (2.3 → 1.3 s = frame 39); "seis" (3.5-3.9) plays at 1.3 + 0.2 = 1.5 s.
    expect(words[2]).toMatchObject({ start: 30, end: 39, clip: "c1" });
    expect(words[3]).toMatchObject({ start: 45, end: 57, clip: "c2" });
  });

  it("follow speed: source seconds divide by the clip's speed", () => {
    // 2x from source 1.0 at timeline 0: "dos" (1.5-1.9) plays at 0.25-0.45 s.
    const words = subtitleWords(timeline([media("c1", 0, 1, 3, 2)]), "s1", lookup, 40);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["uno", 0, 8],
      ["dos", 10, 18],
      ["tres", 20, 28],
      ["cuatro", 30, 38],
    ]);
  });

  it("take the transcript's text corrections; an emptied word is not shown", () => {
    const edited: Transcript = { ...talk, edits: { w_000001: { text: "Uno," }, w_000002: { text: "" }, w_000003: { text: "tr{e}s\\N" } } };
    const words = subtitleWords(timeline([media("c1", 0, 1, 2.5)]), "s1", () => edited, 30);
    // Braces and backslashes would be ASS markup in export: dropped in preview and export alike.
    expect(words.map((w) => w.text)).toEqual(["Uno,", "tresN"]);
  });

  it("are empty for clips without a transcript, and for adapter clips", () => {
    const words = subtitleWords(
      timeline([media("c1", 0, 1, 2), { id: "c_hf", type: "hyperframes", start: 3, duration: 2 }]),
      "s1",
      () => null,
      30,
    );
    expect(words).toEqual([]);
  });
});

describe("subtitle cues", () => {
  const words = subtitleWords(timeline([media("c1", 0, 1, 6)]), "s1", lookup, 30);

  it("group big-keyword words three at a time, upper case, the spoken word highlighted", () => {
    const style = resolveSubtitleStyle({ preset: "big-keyword" }).style;
    const cues = subtitleCues(words, style, 30);
    expect(cues.map((cue) => [cue.start, cue.end, cue.words.map((w) => w.text).join(" ")])).toEqual([
      [0, 42, "UNO DOS TRES"],
      [45, 87, "CUATRO CINCO SEIS"],
      [90, 132, "SIETE OCHO NUEVE"],
      [135, 147, "DIEZ"],
    ]);
    // Frame 20: "dos" started at 15, "tres" not until 30.
    expect(subtitleAt(cues, 20)).toEqual({ cue: cues[0], active: 1 });
    // Between cues (42-44): nothing shows.
    expect(subtitleAt(cues, 43)).toBeNull();
    expect(subtitleAt(cues, 146)).toEqual({ cue: cues[3], active: 0 });
    expect(subtitleAt(cues, 147)).toBeNull();
  });

  it("break at a pause and after a sentence end", () => {
    const pause = subtitleWords(timeline([media("c1", 0, 1, 2), media("c2", 3, 2, 3)]), "s1", lookup, 30);
    const style = resolveSubtitleStyle({ preset: "plain" }).style;
    // "dos" ends at 0.9 s; "tres" starts at 3.0 s after a gap: a new cue, though plain holds seven words.
    expect(subtitleCues(pause, style, 30).map((cue) => cue.words.map((w) => w.text).join(" "))).toEqual(["uno dos", "tres cuatro"]);
    const sentence = subtitleWords(timeline([media("c1", 0, 1, 3)]), "s1", () => ({ ...talk, edits: { w_000002: { text: "dos." } } }), 30);
    expect(subtitleCues(sentence, style, 30).map((cue) => cue.words.map((w) => w.text).join(" "))).toEqual(["uno dos.", "tres cuatro"]);
  });

  it("plain shows no highlighted word", () => {
    const cues = subtitleCues(words, resolveSubtitleStyle({ preset: "plain" }).style, 30);
    expect(subtitleAt(cues, 20)).toEqual({ cue: cues[0], active: -1 });
  });
});

describe("subtitle style", () => {
  it("defaults to big-keyword at the bottom; a position overrides the preset's", () => {
    expect(resolveSubtitleStyle(undefined)).toMatchObject({ style: { preset: "big-keyword", position: "bottom" }, unknownPreset: null });
    expect(resolveSubtitleStyle({ preset: "plain", position: "top" }).style).toMatchObject({ preset: "plain", position: "top" });
  });

  it("falls back to the default preset for an unknown name, and says so", () => {
    expect(resolveSubtitleStyle({ preset: "neon" })).toMatchObject({ style: { preset: "big-keyword" }, unknownPreset: "neon" });
  });

  it("lays text out relative to the frame: same proportions in the preview and in any export size", () => {
    const style = resolveSubtitleStyle({ preset: "big-keyword" }).style;
    const hd = subtitleLayout(style, { width: 1920, height: 1080 });
    const preview = subtitleLayout(style, { width: 960, height: 540 });
    expect(hd.centerX).toBe(960);
    expect(hd.fontSize).toBe(preview.fontSize * 2);
    expect(hd.baseline / 1080).toBeCloseTo(preview.baseline / 540, 2);
    // Bottom: the line box (baseline + descent) ends above the bottom margin.
    expect(hd.baseline).toBeLessThan(1080 * 0.9);
    const top = subtitleLayout({ ...style, position: "top" }, { width: 1920, height: 1080 });
    expect(top.baseline).toBeLessThan(1080 / 3);
    // Portrait: the font follows the short side, so a line fits the width.
    expect(subtitleLayout(style, { width: 1080, height: 1920 }).fontSize).toBe(hd.fontSize);
  });
});

describe("subtitle tracks of a timeline", () => {
  it("resolve every subtitle track and name followed assets without a transcript", () => {
    const tl = timeline([media("c1", 0, 1, 2), { ...media("c2", 2, 0, 1), asset: "assets/other.mp4" }], [
      { id: "s2", kind: "subtitles", follows: "v1", style: { preset: "plain", position: "top" } },
    ]);
    const tracks = subtitleTracks(tl, lookup, 30);
    expect(tracks.map((t) => [t.track, t.style.preset, t.cues.length, t.missing])).toEqual([
      ["s1", "big-keyword", 1, ["assets/other.mp4"]],
      ["s2", "plain", 1, ["assets/other.mp4"]],
    ]);
  });
});
