import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type ExportSource, compileFrame } from "@frameshell/core";
import type { Timeline, Transcript } from "@frameshell/schema";
import { SUBTITLE_FONT, subtitleTracks } from "@frameshell/schema/subtitles";
import { describe, expect, it } from "vitest";
import { readCaptionStyle } from "../src/renderer/src/subtitles/caption-style.js";
import { subtitleLines } from "../src/renderer/src/subtitles/model.js";

// Seam under test: the preview reads style.json and its caption face with the helpers export uses, so the line it
// draws has the face, size, colours and baseline the ASS export burns (ADR 0028 decision 11).

const require = createRequire(import.meta.url);
const BUNDLED = readFileSync(require.resolve(SUBTITLE_FONT.module));
const bytes = () => BUNDLED.buffer.slice(BUNDLED.byteOffset, BUNDLED.byteOffset + BUNDLED.byteLength) as ArrayBuffer;

const STYLE = JSON.stringify({
  schemaVersion: 1,
  colors: { ink: "#00ff00", bg: "#0000ff" },
  fonts: { captions: { family: "Brand", file: "assets/fonts/Brand.ttf" } },
  type: { caption: 81 },
});

const transcript: Transcript = {
  schemaVersion: 1,
  asset: "assets/take.mp4",
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  words: [
    { id: "w_000001", text: "hola", start: 0.1, end: 0.3 },
    { id: "w_000002", text: "mundo", start: 0.4, end: 0.8 },
  ],
  edits: {},
};
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    { id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/take.mp4", start: 0, in: 0, out: 1 }] },
    { id: "s1", kind: "subtitles", follows: "v1" },
  ],
};

describe("caption style in the preview", () => {
  it("is nothing without a valid style.json", async () => {
    const load = () => Promise.reject(new Error("not asked"));
    expect(await readCaptionStyle(null, load)).toEqual({ tokens: undefined, face: null });
    expect(await readCaptionStyle("{ nope", load)).toEqual({ tokens: undefined, face: null });
    expect(await readCaptionStyle('{"schemaVersion":1,"colors":{"ink":"green"}}', load)).toEqual({ tokens: undefined, face: null });
  });

  it("reads the project face's family and metrics from its bytes, and keeps them to register the face", async () => {
    const asked: string[] = [];
    const style = await readCaptionStyle(STYLE, async (file) => (asked.push(file), bytes()));
    expect(asked).toEqual(["assets/fonts/Brand.ttf"]);
    expect(style.tokens?.font).toEqual({ family: SUBTITLE_FONT.family, file: "assets/fonts/Brand.ttf", ascent: SUBTITLE_FONT.ascent, descent: SUBTITLE_FONT.descent });
    expect(style.face?.byteLength).toBe(BUNDLED.byteLength);
    const failing = await readCaptionStyle(STYLE, () => Promise.reject(new Error("HTTP 404")));
    expect(failing).toMatchObject({ tokens: { font: { file: null }, values: { color: "#00ff00" } }, face: null });
  });

  it("draws the line export burns: same face, size, colours and baseline", async () => {
    const { tokens } = await readCaptionStyle(STYLE, async () => bytes());
    const size = { width: 1920, height: 1080 };
    const lookup = (asset: string) => (asset === transcript.asset ? transcript : null);
    const [line] = subtitleLines(subtitleTracks(timeline, lookup, 30, tokens), 6, size, (text) => text.length * 10);
    expect(line).toMatchObject({ font: `81px "${SUBTITLE_FONT.family}"`, outlineColor: "#0000ff" });
    expect(line!.runs.map((run) => run.color)).toEqual(["#ffd426", "#00ff00"]);
    const source: ExportSource = { path: "/take.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true };
    const plan = compileFrame({
      timeline,
      fps: 30,
      sources: new Map([[transcript.asset, source]]),
      transcripts: new Map([[transcript.asset, transcript]]),
      ...(tokens ? { captions: tokens } : {}),
      resolution: size,
      width: size.width,
      height: size.height,
      at: 0.2,
      output: "frame.png",
    });
    const ass = plan.files["subtitles.ass"]!;
    const [, family, fontSize, primary, , outline] = /^Style: t0,([^,]+),([\d.]+),([^,]+),([^,]+),([^,]+),/m.exec(ass)!;
    expect(family).toBe(SUBTITLE_FONT.family);
    expect(Number(fontSize)).toBeCloseTo(81 * (SUBTITLE_FONT.ascent + SUBTITLE_FONT.descent), 2);
    expect([primary, outline]).toEqual(["&H0000FF00&", "&H00FF0000&"]);
    // The ASS anchor is the bottom of the line box: the preview's baseline plus the face's descent.
    const y = Number(/\\pos\([\d.]+,([\d.]+)\)/.exec(ass)![1]);
    expect(y).toBeCloseTo(line!.baseline + 81 * SUBTITLE_FONT.descent, 1);
    expect(plan.fonts).toEqual(["assets/fonts/Brand.ttf"]);
  });
});
