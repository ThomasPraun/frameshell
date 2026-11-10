import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { SUBTITLE_FONT, type Timeline, type Transcript } from "@frameshell/schema";
import {
  BUILTIN_PRESETS,
  COVER_FILE,
  type ExportSource,
  MIN_THUMBNAIL_CAP_HEIGHT,
  THUMBNAIL_WIDTH,
  assCover,
  compileFrame,
  compileRender,
  coverReadability,
  coverText,
  firstPictureTime,
  hookWordTime,
  layoutCover,
  bundledFontMetrics,
  fontSource,
  parseFontMetrics,
} from "../src/index.js";

const youtube = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
const resolution = { width: 1920, height: 1080 };
const sources = new Map<string, ExportSource>([
  ["assets/talk.mp4", { path: "/project/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true }],
]);

const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/talk.mp4", start: 0, in: 10, out: 14 }] }],
};

/** Speech of the clip's source: "pero" at 10.5 s, "Nunca más" at 12 s (the clip plays 10 to 14 s). */
const transcript: Transcript = {
  schemaVersion: 1,
  asset: "assets/talk.mp4",
  assetHash: `sha256:${"a".repeat(64)}`,
  provider: "test",
  model: "test",
  words: [
    { id: "w1", text: "Pero,", start: 10.5, end: 10.8 },
    { id: "w2", text: "nunca", start: 12, end: 12.4 },
    { id: "w3", text: "más.", start: 12.4, end: 12.8 },
    { id: "w4", text: "Antes", start: 3, end: 3.3 },
  ],
  edits: {},
};
const lookup = (asset: string) => (asset === "assets/talk.mp4" ? transcript : null);

describe("font metrics of the bundled face", () => {
  it("reads advance widths and the cap height out of the TrueType file", async () => {
    const metrics = parseFontMetrics(await readFile(fontSource(SUBTITLE_FONT.file)));
    expect(metrics.capHeight).toBeGreaterThan(0.55);
    expect(metrics.capHeight).toBeLessThan(0.85);
    // A heavy display face: capitals are wide, "I" is the narrowest, "W" among the widest.
    expect(metrics.width("I")).toBeGreaterThan(0.2);
    expect(metrics.width("W")).toBeGreaterThan(metrics.width("I") * 1.5);
    expect(metrics.width("HOLA")).toBeCloseTo(metrics.width("H") + metrics.width("O") + metrics.width("L") + metrics.width("A"), 6);
    // A character the face lacks takes the .notdef width instead of failing.
    expect(metrics.width("\u{1F600}")).toBeGreaterThan(0);
  });
});

describe("cover layout", () => {
  it("draws upper-case text with ASS markup removed, nothing when nothing is left", () => {
    expect(coverText("  nunca   {\\b1}más ")).toBe("NUNCA B1MÁS");
    expect(coverText(" {} ")).toBe("");
  });

  it("fills the width on a vertical frame and the height cap on a wide one", async () => {
    const metrics = await bundledFontMetrics();
    const vertical = layoutCover("HOOK", { width: 1080, height: 1920 }, metrics);
    const drawn = metrics.width("HOOK") * vertical.fontSize + 2 * vertical.outline;
    expect(drawn).toBeLessThanOrEqual(1080 * 0.84 + 1);
    expect(drawn).toBeGreaterThan(1080 * 0.78);
    expect(vertical).toMatchObject({ centerX: 540, color: "#ffd426", outlineColor: "#000000" });

    const wide = layoutCover("HOOK", { width: 1920, height: 1080 }, metrics);
    expect(wide.fontSize).toBe(Math.floor(1080 * 0.32));
    // The capitals are centered on the middle of the frame.
    expect(wide.baseline - (wide.fontSize * metrics.capHeight) / 2).toBeCloseTo(540, 1);
  });

  it("turns the outline white on a dark fill", async () => {
    const metrics = await bundledFontMetrics();
    expect(layoutCover("A", resolution, metrics, "#101010").outlineColor).toBe("#ffffff");
    expect(layoutCover("A", resolution, metrics, "#ffffff").outlineColor).toBe("#000000");
  });

  it("writes an ASS script with one centered event in the bundled face", async () => {
    const metrics = await bundledFontMetrics();
    const ass = assCover(layoutCover("HOOK", resolution, metrics), resolution);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain(`Style: cover,${SUBTITLE_FONT.family},`);
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,.*,cover,,0,0,0,,\{\\an2\\pos\(960,[\d.]+\)\}HOOK/);
  });
});

describe("cover readability at thumbnail size", () => {
  it("passes a short word and fails a long phrase", async () => {
    const metrics = await bundledFontMetrics();
    const short = layoutCover("HOOK", resolution, metrics);
    expect(coverReadability(short, resolution, metrics)).toMatchObject({ thumbnailWidth: THUMBNAIL_WIDTH, readable: true });
    expect(coverReadability(short, resolution, metrics).capHeight).toBeGreaterThanOrEqual(MIN_THUMBNAIL_CAP_HEIGHT);

    const long = layoutCover(coverText("la verdad sobre el tiempo"), resolution, metrics);
    const check = coverReadability(long, resolution, metrics);
    expect(check.readable).toBe(false);
    expect(check.capHeight).toBeLessThan(MIN_THUMBNAIL_CAP_HEIGHT);
  });
});

describe("hook word and default frame", () => {
  it("finds where a word is first spoken on the timeline, ignoring case, accents and punctuation", () => {
    // Source 10.5 s plays at timeline 0.5 s; "nunca" at source 12 s is timeline 2 s.
    expect(hookWordTime(timeline, lookup, "pero", 30)).toBeCloseTo(0.5, 2);
    expect(hookWordTime(timeline, lookup, "NUNCA MAS", 30)).toBeCloseTo(2, 2);
    expect(hookWordTime(timeline, lookup, "más", 30)).toBeCloseTo(2.4, 2);
  });

  it("is null for a word nobody says, one cut out of the clip, or a phrase out of order", () => {
    expect(hookWordTime(timeline, lookup, "antes", 30)).toBeNull();
    expect(hookWordTime(timeline, lookup, "jamás", 30)).toBeNull();
    expect(hookWordTime(timeline, lookup, "más nunca", 30)).toBeNull();
    expect(hookWordTime(timeline, () => null, "pero", 30)).toBeNull();
  });

  it("starts the default frame where the first picture does", () => {
    expect(firstPictureTime(timeline)).toBe(0);
    const late: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/talk.mp4", start: 1.5, in: 10, out: 14 }] }] };
    expect(firstPictureTime(late)).toBe(1.5);
    expect(firstPictureTime({ ...timeline, tracks: [] })).toBe(0);
  });
});

describe("cover in plans", () => {
  const layout = layoutCover("HOOK", resolution, {
    capHeight: 0.7,
    width: (text) => text.length * 0.8,
  });
  const frame = (cover: Parameters<typeof compileFrame>[0]["cover"]) =>
    compileFrame({ timeline, fps: 30, sources, resolution, width: 1920, height: 1080, at: 2, output: "/out/c.png", ...(cover !== undefined ? { cover } : {}) });

  it("burns the cover word into a frame instead of subtitles", () => {
    const plan = frame(layout);
    expect(Object.keys(plan.files)).toEqual([COVER_FILE]);
    expect(plan.files[COVER_FILE]).toContain("HOOK");
    expect(plan.fonts).toEqual([SUBTITLE_FONT.file]);
    expect(plan.args.join(" ")).toContain(`ass=filename=${COVER_FILE}:fontsdir=fonts`);
  });

  it("a cover without a word is the bare frame", () => {
    const plan = frame(null);
    expect(plan.files).toEqual({});
    expect(plan.fonts).toEqual([]);
    expect(plan.args.join(" ")).not.toContain("ass=");
  });

  const render = (extra: object = {}, tl: Timeline = timeline) => compileRender({ timeline: tl, fps: 30, preset: youtube, loudness: -17, sources, resolution, ...extra });

  it("renders frame 0 as its own one-frame segment of the cover frame; the rest follows, same length", () => {
    const plain = render();
    const plan = render({ cover: { at: 2, layout } });
    expect(plan.frames).toBe(plain.frames);
    expect(plan.segments.map((s) => [s.from, s.to, s.frames])).toEqual([
      [0, 0.033, 1],
      [0.033, 4, 119],
    ]);
    const [first, rest] = plan.segments;
    expect(first!.args.join(" ")).toContain("seg-0001.filter");
    expect(plan.files["seg-0001.filter"]).toContain(`ass=filename=${COVER_FILE}`);
    // The cover segment seeks the source to the cover frame (2 s → source 12 s, less the 1 s preroll); the rest starts at frame 1.
    expect(first!.args.slice(first!.args.indexOf("-ss"), first!.args.indexOf("-ss") + 2)).toEqual(["-ss", "11"]);
    expect(Number(rest!.args[rest!.args.indexOf("-ss") + 1])).toBeCloseTo(9.033, 3);
    expect(plan.files["seg-0002.filter"]).not.toContain("ass=");
    expect(rest!.args.join(" ")).toContain("seg-0002.filter");
    expect(plan.files[COVER_FILE]).toContain("HOOK");
    expect(plan.fonts).toEqual([SUBTITLE_FONT.file]);
    expect(plan.warnings).toEqual([]);
  });

  it("a cover with no word still replaces frame 0 with the chosen frame", () => {
    const plan = render({ cover: { at: 2, layout: null } });
    expect(plan.segments[0]!.frames).toBe(1);
    expect(plan.files[COVER_FILE]).toBeUndefined();
    expect(plan.fonts).toEqual([]);
  });

  it("refuses a cover frame outside the timeline with the valid range", () => {
    expect(() => render({ cover: { at: 9, layout } })).toThrowError(expect.objectContaining({ code: ErrorCode.InvalidOperation, data: expect.objectContaining({ field: "at" }) }));
  });

  it("leaves frame 0 alone, with a warning, when the preset changes the frame rate", () => {
    const slow = { ...youtube, video: { ...youtube.video, fps: 24 } };
    const plan = compileRender({ timeline, fps: 30, preset: slow, loudness: -17, sources, resolution, cover: { at: 2, layout } });
    expect(plan.segments).toHaveLength(1);
    expect(plan.warnings).toEqual([expect.stringContaining("frame rate")]);
  });

  it("warns when frame 0 is black: a gap before the first picture, or a fade in from black", () => {
    const gap: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/talk.mp4", start: 1, in: 10, out: 12 }] }] };
    expect(render({}, gap).warnings).toEqual([expect.stringMatching(/Frame 0 is black \(no picture starts at 0\).*--cover-frame/)]);
    const fade: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "assets/talk.mp4", start: 0, in: 10, out: 12, fadeIn: 0.5 }] }] };
    expect(render({}, fade).warnings).toEqual([expect.stringContaining("fades in from black")]);
    expect(render().warnings).toEqual([]);
    // Choosing a cover is the answer to the warning.
    expect(render({ cover: { at: 1, layout } }, gap).warnings).toEqual([]);
  });
});
