import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { agentInput, referenceLines, referenceTime } from "../src/renderer/src/ask/reference.js";
import type { Selection, SelectedWord } from "../src/renderer/src/selection.js";

// Seam under test: "Ask agent" (#49) reference text, SPEC §10 format. Selection and timeline view in, the
// lines typed into the agent terminal out; then the exact keystrokes for a terminal with or without bracketed paste.

const ASSET = "assets/take.mp4";
const TRANSCRIPT = "transcripts/take.words.json";

const view: TimelineView = {
  timeline: "main",
  path: "timelines/main.json",
  revision: 3,
  fps: 30,
  duration: 200,
  problems: [],
  tracks: [
    {
      id: "v1",
      kind: "video",
      name: "Picture",
      follows: null,
      clips: [
        // Source 0–10 at 0 s, then source 190–200 from 190 s: c_0012 plays source 190 at timeline 190.
        { id: "c_0001", type: "media", asset: ASSET, start: 0, end: 10, in: 0, out: 10 },
        { id: "c_0012", type: "media", asset: ASSET, start: 190, end: 200, in: 190, out: 200 },
      ],
    },
    {
      id: "v2",
      kind: "video",
      name: null,
      follows: null,
      clips: [{ id: "c_0020", type: "hyperframes", source: "compositions/hyperframes/intro/index.html", start: 3, end: 8, duration: 5 }],
    },
  ],
};

const blank: Selection = { clips: [], words: [], range: null, origin: null, reveal: null, history: null, files: [], scene: null, region: null, track: null };
const word = (id: string, text: string, start: number, end: number): SelectedWord => ({ transcript: TRANSCRIPT, asset: ASSET, word: id, text, start, end });

describe("reference lines", () => {
  it("formats timeline times as hours, minutes, seconds and hundredths", () => {
    expect(referenceTime(0)).toBe("00:00:00.00");
    expect(referenceTime(192.4)).toBe("00:03:12.40");
    expect(referenceTime(3725.01)).toBe("01:02:05.01");
  });

  it("quotes selected words as one subtitle line with timeline times, the clip and the word id range (SPEC §10)", () => {
    const words = [
      word("w_000123", "hola", 192.4, 192.7),
      word("w_000124", "a", 192.7, 192.9),
      word("w_000127", "todos", 193.6, 194.1),
    ];
    const selection: Selection = { ...blank, words, range: { from: 192.4, to: 194.1 }, origin: "transcript" };
    expect(referenceLines(selection, view)).toEqual([
      '[frameshell] subtitle "hola a todos" · 00:03:12.40–00:03:14.10 · clip c_0012 · words w_000123–w_000127',
    ]);
  });

  it("splits words across a cut into one line per clip, and names a lone word", () => {
    const words = [word("w_000010", "end", 9.2, 9.6), word("w_000400", "start", 190.1, 190.5)];
    const selection: Selection = { ...blank, words, range: { from: 9.2, to: 190.5 }, origin: "transcript" };
    expect(referenceLines(selection, view)).toEqual([
      '[frameshell] subtitle "end" · 00:00:09.20–00:00:09.60 · clip c_0001 · word w_000010',
      '[frameshell] subtitle "start" · 00:03:10.10–00:03:10.50 · clip c_0012 · word w_000400',
    ]);
  });

  it("escapes quotes and shortens long quoted text", () => {
    const long = Array.from({ length: 30 }, (_, k) => word(`w_${String(k + 1).padStart(6, "0")}`, k === 0 ? 'say "hi"' : "word", k * 0.3, k * 0.3 + 0.2));
    const [line] = referenceLines({ ...blank, words: long, range: { from: 0, to: 8.9 }, origin: "transcript" }, view);
    expect(line).toMatch(/^\[frameshell\] subtitle "say \\"hi\\" word word .*…" · 00:00:00\.00–00:00:08\.90 · clip c_0001 · words w_000001–w_000030$/);
    expect(/subtitle "(.*)" · /.exec(line!)![1]!.length).toBeLessThan(70);
  });

  it("writes one line per selected clip, with what it plays, where and on which track", () => {
    const selection: Selection = { ...blank, clips: ["c_0020", "c_0001", "c_gone"], origin: "timeline" };
    expect(referenceLines(selection, view)).toEqual([
      "[frameshell] clip c_0020 · hyperframes compositions/hyperframes/intro/index.html · 00:00:03.00–00:00:08.00 · track v2",
      "[frameshell] clip c_0001 · media assets/take.mp4 · 00:00:00.00–00:00:10.00 · track v1",
      "[frameshell] clip c_gone",
    ]);
  });

  it("names a History pick before the clips it changed", () => {
    const selection: Selection = { ...blank, clips: ["c_0001"], origin: "history", history: "tx_0000000a" };
    expect(referenceLines(selection, view)).toEqual([
      "[frameshell] transaction tx_0000000a",
      "[frameshell] clip c_0001 · media assets/take.mp4 · 00:00:00.00–00:00:10.00 · track v1",
    ]);
  });

  it("writes a timeline range, explorer files, a script scene and a preview region", () => {
    expect(referenceLines({ ...blank, range: { from: 2, to: 4.5 }, origin: "timeline" }, view)).toEqual([
      "[frameshell] range 00:00:02.00–00:00:04.50",
    ]);
    expect(referenceLines({ ...blank, files: ["assets/logo.png", "scripts/script.md"], origin: "explorer" }, view)).toEqual([
      "[frameshell] asset assets/logo.png",
      "[frameshell] file scripts/script.md",
    ]);
    const scene = { script: "scripts/script.md", slug: "intro", title: "Intro" };
    expect(referenceLines({ ...blank, scene, clips: ["c_0001", "c_0012"], origin: "script" }, view)).toEqual([
      '[frameshell] scene scripts/script.md#intro "Intro" · clips c_0001, c_0012',
    ]);
    expect(referenceLines({ ...blank, scene, origin: "script" }, view)).toEqual(['[frameshell] scene scripts/script.md#intro "Intro"']);
    const region = { x0: 0.62, y0: 0.08, x1: 0.94, y1: 0.2249, at: 65.2 };
    expect(referenceLines({ ...blank, region, origin: "preview" }, view, { frame: ".frameshell/context/f_1956.png" })).toEqual([
      "[frameshell] region (0.62,0.08)–(0.94,0.22) @ 00:01:05.20 · frame .frameshell/context/f_1956.png",
    ]);
    expect(referenceLines({ ...blank, region, origin: "preview" }, view)).toEqual(["[frameshell] region (0.62,0.08)–(0.94,0.22) @ 00:01:05.20"]);
  });

  it("has nothing to say about an empty selection", () => {
    expect(referenceLines(blank, view)).toEqual([]);
  });
});

describe("agent input", () => {
  const lines = ["[frameshell] asset assets/a.png", "[frameshell] asset assets/b.png"];

  it("never presses Enter: one line ends in a space for the question", () => {
    expect(agentInput(lines.slice(0, 1), true)).toBe("[frameshell] asset assets/a.png ");
    expect(agentInput(lines.slice(0, 1), false)).toBe("[frameshell] asset assets/a.png ");
  });

  it("puts lines on their own rows only inside a bracketed paste, else joins them on one row", () => {
    expect(agentInput(lines, true)).toBe("[frameshell] asset assets/a.png\n[frameshell] asset assets/b.png\n");
    expect(agentInput(lines, false)).toBe("[frameshell] asset assets/a.png [frameshell] asset assets/b.png ");
  });

  it("strips control characters a file name or transcript could smuggle in (Enter, escape sequences)", () => {
    expect(agentInput(['[frameshell] subtitle "a\rb\u001b[201~c"'], true)).toBe('[frameshell] subtitle "a b [201~c" ');
  });
});
