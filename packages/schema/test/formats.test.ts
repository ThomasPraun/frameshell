import { describe, expect, it } from "vitest";
import {
  type Timeline,
  clipInFormat,
  createProjectConfig,
  formatTimeline,
  parseProjectConfig,
  parseTimeline,
  primaryFormatId,
  projectFormats,
  resolveFormat,
  sameAspect,
} from "../src/index.js";

const timeline: Timeline = { schemaVersion: 1, id: "main", revision: 0, tracks: [] };
const landscape = { resolution: { width: 1920, height: 1080 } };

describe("project formats (ADR 0027)", () => {
  it("gives a project without formats one, its resolution, named by its built-in canvas or its size", () => {
    expect(projectFormats(landscape)).toEqual([{ id: "16x9", width: 1920, height: 1080 }]);
    expect(projectFormats({ resolution: { width: 1080, height: 1920 } })).toEqual([{ id: "9x16", width: 1080, height: 1920 }]);
    expect(primaryFormatId({ width: 3840, height: 2160 })).toBe("3840x2160");
  });

  it("resolves the primary format as the timeline is, every other one covering, vertical captions 1.3x", () => {
    const config = { ...landscape, formats: [{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }, { id: "1x1", width: 1080, height: 1080 }] };
    const primary = resolveFormat(timeline, config)!;
    expect(primary.timeline).toBe(timeline);
    expect(primary.format).toEqual({ id: "16x9", width: 1920, height: 1080, primary: true, cover: false, captionScale: 1 });
    expect(resolveFormat(timeline, config, "9x16")!.format).toMatchObject({ primary: false, cover: true, captionScale: 1.3 });
    expect(resolveFormat(timeline, config, "1x1")!.format).toMatchObject({ primary: false, cover: true, captionScale: 1 });
    expect(resolveFormat(timeline, config, "4x5")).toBeNull();
  });

  it("keeps captions as styled in a vertical primary format", () => {
    expect(resolveFormat(timeline, { resolution: { width: 1080, height: 1920 } })!.format).toMatchObject({ id: "9x16", cover: false, captionScale: 1 });
  });

  it("compares aspects within 1 %", () => {
    expect(sameAspect({ width: 1920, height: 1080 }, { width: 2560, height: 1440 })).toBe(true);
    expect(sameAspect({ width: 1366, height: 768 }, { width: 1920, height: 1080 })).toBe(true);
    expect(sameAspect({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toBe(false);
  });

  describe("in frameshell.json", () => {
    const base = createProjectConfig("Launch");
    const parse = (formats: unknown, extra: Record<string, unknown> = {}) => parseProjectConfig({ ...base, ...extra, formats });

    it("accepts the primary first plus built-in and custom formats", () => {
      const result = parse([{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }, { id: "web-1600x900", width: 1600, height: 900 }]);
      expect(result.ok).toBe(true);
    });

    it.each([
      [[{ id: "9x16", width: 1080, height: 1920 }], /formats\.0: the first format is the primary one and must equal `resolution`/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "16x9", width: 1920, height: 1080 }], /formats\.1\.id: format id 16x9 is listed twice/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 720, height: 1280 }], /formats\.1: built-in format 9x16 is 1080x1920; use a custom id/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "odd", width: 1081, height: 1920 }], /formats\.1: format odd is 1081x1920; video encoders need even sizes/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "png", width: 1080, height: 1920 }], /formats\.1\.id: must not be an image type/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "Vertical", width: 1080, height: 1920 }], /formats\.1\.id: must be lowercase letters/],
      [[], /formats: Too small/],
    ])("refuses %j", (formats, error) => {
      const result = parse(formats);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(error);
    });

    it("refuses formats in an image project", () => {
      const result = parse([{ id: "16x9", width: 1920, height: 1080 }], { kind: "image" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/formats: image projects have one frame/);
    });
  });
});

describe("per-format overrides (ADR 0027 decision 5)", () => {
  const config = { ...landscape, formats: [{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }] };
  const overridden = (): Timeline => ({
    schemaVersion: 1,
    id: "main",
    revision: 3,
    tracks: [
      { id: "t_base", kind: "video", clips: [{ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 4 }] },
      {
        id: "t_top",
        kind: "video",
        muted: true,
        clips: [
          {
            id: "c_title",
            type: "hyperframes",
            start: 0,
            duration: 2,
            transform: { x: 200, y: 300, scale: 0.5 },
            keys: { y: [{ at: 0, value: 300 }, { at: 1, value: 250 }], opacity: [{ at: 0, value: 0 }, { at: 0.5, value: 1 }] },
            props: { title: "Launch", size: 80 },
            formats: { "9x16": { transform: { y: 700 }, keys: { x: [{ at: 0, value: 0 }] }, props: { size: 110 } } },
          },
          { id: "c_logo", type: "media", asset: "assets/logo.png", start: 2, in: 0, out: 2, formats: { "9x16": { hidden: true } } },
        ],
      },
      { id: "t_subs", kind: "subtitles", follows: "t_base", style: { preset: "clean", position: "bottom" }, formats: { "9x16": { style: { position: "center" } } } },
    ],
  });

  it("leaves the primary format and a timeline without overrides in a format as they are", () => {
    const stored = overridden();
    expect(resolveFormat(stored, config)!.timeline).toBe(stored);
    expect(resolveFormat(timeline, config, "9x16")!.timeline).toBe(timeline);
  });

  it("lays the override over the clip: transform fields, keys per property, props key by key", () => {
    const { timeline: shown } = resolveFormat(overridden(), config, "9x16")!;
    const top = shown.tracks[1]!;
    const title = top.kind === "video" ? top.clips[0]! : null;
    expect(title).toMatchObject({ transform: { x: 200, y: 700, scale: 0.5 }, props: { title: "Launch", size: 110 } });
    // `y` is set in the format, so the clip's own `y` keys go; `opacity` keeps the clip's keys, `x` takes the format's.
    expect(title!.keys).toEqual({ opacity: [{ at: 0, value: 0 }, { at: 0.5, value: 1 }], x: [{ at: 0, value: 0 }] });
  });

  it("keeps a clip hidden in the format on its track at opacity 0, so its sound, transitions and captions stay", () => {
    const { timeline: shown } = resolveFormat(overridden(), config, "9x16")!;
    expect(shown.tracks.map((track) => track.id)).toEqual(["t_base", "t_top", "t_subs"]);
    const top = shown.tracks[1]!;
    expect(top).toMatchObject({ kind: "video", muted: true });
    const logo = top.kind === "video" ? top.clips[1]! : null;
    expect(logo).toMatchObject({ id: "c_logo", start: 2, transform: { opacity: 0 } });
    expect(logo).not.toHaveProperty("keys");
  });

  it("drops a hidden clip's opacity keys and keeps its others", () => {
    const stored = overridden();
    const title = (stored.tracks[1] as { clips: Record<string, unknown>[] }).clips[0]!;
    title["formats"] = { "9x16": { hidden: true } };
    const { timeline: shown } = resolveFormat(stored, config, "9x16")!;
    const top = shown.tracks[1]!;
    const hidden = top.kind === "video" ? top.clips[0]! : null;
    expect(hidden).toMatchObject({ transform: { x: 200, y: 300, scale: 0.5, opacity: 0 } });
    expect(hidden!.keys).toEqual({ y: [{ at: 0, value: 300 }, { at: 1, value: 250 }] });
  });

  it("gives a subtitle track the format's style fields over its own", () => {
    const { timeline: shown } = resolveFormat(overridden(), config, "9x16")!;
    expect(shown.tracks[2]).toMatchObject({ style: { preset: "clean", position: "center" } });
  });

  it("works on a timeline view, whose clips carry derived fields", () => {
    const view = { tracks: [{ id: "t_top", kind: "video", name: null, clips: [{ id: "c_a", end: 2, transform: { x: 5 }, formats: { "9x16": { transform: { x: 9 } } } }] }] };
    expect(formatTimeline(view, "9x16").tracks[0]!.clips[0]).toMatchObject({ end: 2, transform: { x: 9 } });
    expect(clipInFormat(view.tracks[0]!.clips[0]!, "1x1")).toBe(view.tracks[0]!.clips[0]);
  });

  it("gives a view's subtitle track, which carries `clips: []`, the format's style", () => {
    const view = {
      tracks: [
        { id: "t_v", kind: "video", name: null, clips: [] },
        { id: "t_subs", kind: "subtitles", name: null, follows: "t_v", clips: [], style: { preset: "clean", position: "bottom" }, formats: { "9x16": { style: { position: "center" } } } },
      ],
    };
    expect(formatTimeline(view, "9x16").tracks[1]).toMatchObject({ clips: [], style: { preset: "clean", position: "center" } });
    expect(formatTimeline(view, "1x1")).toBe(view);
  });

  it("is refused on audio tracks, as are props or elements on footage and gain keys", () => {
    const stored = overridden();
    expect(parseTimeline(stored).ok).toBe(true);
    const footage = structuredClone(stored);
    (footage.tracks[0] as { clips: Record<string, unknown>[] }).clips[0]!["formats"] = { "9x16": { props: { a: 1 } } };
    const refused = parseTimeline(footage);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/only generated clips take `props`/);
    const sound: Timeline = {
      ...stored,
      tracks: [{ id: "t_music", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "a.wav", start: 0, in: 0, out: 1, formats: { "9x16": { transform: { x: 1 } } } }] }],
    };
    const audio = parseTimeline(sound);
    expect(audio.ok).toBe(false);
    if (!audio.ok) expect(audio.error).toMatch(/audio tracks have no picture to change per format/);
    const gain = structuredClone(stored);
    (gain.tracks[1] as { clips: Record<string, unknown>[] }).clips[0]!["formats"] = { "9x16": { keys: { gain: [{ at: 0, value: -3 }] } } };
    expect(parseTimeline(gain).ok).toBe(false);
  });
});
