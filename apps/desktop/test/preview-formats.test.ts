import { type ExportSource, type GeneratedSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, ClipRenderInfo, TimelineView } from "@frameshell/protocol";
import type { Clip, Timeline, Transcript } from "@frameshell/schema";
import { type LayerRect, flattenTimeline } from "@frameshell/schema/composite";
import { type FormatSource, formatOf, projectFormats, resolveFormat, scaledCaptions } from "@frameshell/schema/formats";
import { SUBTITLE_FONT, subtitleLayout, subtitleTracks } from "@frameshell/schema/subtitles";
import { describe, expect, it } from "vitest";
import { type Program, compileProgram, programAt } from "../src/renderer/src/preview/program.js";

// Seam under test: the preview's format switcher (ADR 0027 slice 2) lays a timeline out in each project format with
// the helpers export uses (`formatOf`, `formatCrop`, `scaledCaptions`): the same source pixels cover the frame, the
// same clips stay fitted, captions get the same size.

const FPS = 30;
const PROJECT: FormatSource = {
  resolution: { width: 1920, height: 1080 },
  formats: [
    { id: "16x9", width: 1920, height: 1080 },
    { id: "9x16", width: 1080, height: 1920 },
    { id: "1x1", width: 1080, height: 1080 },
    { id: "4x5", width: 1080, height: 1350 },
    { id: "web-1600x900", width: 1600, height: 900 },
  ],
};

interface Source {
  width: number;
  height: number;
  still?: boolean;
  alpha?: boolean;
}

const SOURCES: Record<string, Source> = {
  "assets/talk.mp4": { width: 1920, height: 1080 },
  "assets/small.mp4": { width: 1280, height: 720 },
  "assets/broll.mp4": { width: 1920, height: 1080 },
  "assets/keyed.mp4": { width: 1920, height: 1080 },
  "assets/title.webm": { width: 1920, height: 1080, alpha: true },
  "assets/plate.webm": { width: 1920, height: 1080, alpha: true },
  "assets/frame.png": { width: 1920, height: 1080, still: true, alpha: true },
  "assets/logo.png": { width: 400, height: 400, still: true },
};

function asset(path: string, source: Source): AssetInfo {
  const key = path.replace(/\W/g, "");
  return {
    path,
    kind: "media",
    hash: `sha256:${key}`,
    state: "ready",
    error: null,
    media: {
      duration: source.still ? null : 60,
      format: source.still ? "png_pipe" : "mov,mp4",
      video: { codec: "h264", width: source.width, height: source.height, fps: source.still ? null : 30, vfr: false, still: source.still === true, alpha: source.alpha === true },
      audio: null,
    },
    proxy: source.still ? null : `.frameshell/proxies/${key}.${source.alpha ? "webm" : "mp4"}`,
    sidecar: null,
    waveform: null,
    thumbnails: null,
  };
}

const ASSETS = new Map(Object.entries(SOURCES).map(([path, source]) => [path, asset(path, source)] as const));
const EXPORT_SOURCES = new Map<string, ExportSource>(
  Object.entries(SOURCES).map(([path, source]) => [
    path,
    {
      path: `/abs/${path}`,
      video: { codec: source.still ? "png" : "h264", still: source.still === true, width: source.width, height: source.height, ...(source.alpha ? { alpha: true } : {}) },
      audio: false,
      ...(source.still ? {} : { duration: 60 }),
    },
  ]),
);

const media = (id: string, path: string, start: number, extra: Partial<Clip> = {}): Clip => ({ id, type: "media", asset: path, start, in: 0, out: 2, ...extra }) as Clip;

/** Base footage under an upper track whose clips change every 2 s; each clip shows from `start` to `start + 2`. */
function stack(base: string, upper: Clip[]): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [media("c_base", base, 0, { out: 12 })] },
      { id: "v2", kind: "video", clips: upper },
    ],
  };
}

const UPPER: Clip[] = [
  media("c_broll", "assets/broll.mp4", 0),
  media("c_title", "assets/title.webm", 2),
  media("c_frame", "assets/frame.png", 4),
  media("c_logo", "assets/logo.png", 6, { transform: { x: 600, y: -300, scale: 0.5 } }),
  media("c_keyed", "assets/keyed.mp4", 8, { keys: { opacity: [{ at: 0, value: 1 }, { at: 1, value: 0.5 }] } }),
  { id: "c_gen", type: "hyperframes", source: "compositions/t/index.html", start: 10, duration: 2 } as Clip,
];

/** `timeline` as `timeline.show` returns it: clips with their derived `end`. */
function viewOf(timeline: Timeline): TimelineView {
  const tracks = timeline.tracks.map((track) => {
    if (track.kind === "subtitles") return { ...track, name: null, clips: [] };
    const clips = track.clips.map((clip) => {
      const length = "duration" in clip && typeof clip.duration === "number" ? clip.duration : (clip as { out: number; in: number }).out - (clip as { in: number }).in;
      return { ...clip, end: clip.start + length };
    });
    return { ...track, name: null, follows: null, clips };
  });
  return { timeline: timeline.id, path: `timelines/${timeline.id}.json`, revision: timeline.revision, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
}

const RENDERS = new Map<string, ClipRenderInfo>([["c_gen", { clip: "c_gen", state: "ready", file: ".frameshell/cache/clips/gen.webm", width: 1920, height: 1080 } as ClipRenderInfo]]);
const GENERATED = new Map<string, GeneratedSource>([["c_gen", { path: "/abs/gen.webm", hasAlpha: true, width: 1920, height: 1080 }]]);

function preview(timeline: Timeline, id: string): Program {
  const format = formatOf(PROJECT, id)!;
  return compileProgram(viewOf(timeline), ASSETS, { resolution: PROJECT.resolution, renders: RENDERS, format });
}

const crop = (rect: LayerRect) => `crop=${rect.width}:${rect.height}:${rect.left}:${rect.top}`;

/** Each picture the preview draws at `frame`, bottom first: `<clip> <crop>` when it covers, else `<clip> fit`. */
function previewed(program: Program, frame: number): string[] {
  return program.layers.flatMap((_, layer) => {
    const span = programAt(program, frame, layer);
    if (!span || span.kind === "placeholder" || span.kind === "angle") return [];
    return [`${span.clip} ${"cover" in span && span.cover ? crop(span.cover) : "fit"}`];
  });
}

/** Each input export reads for the frame at `frame`, in input order: `<clip> <crop>` when its chain crops, else `<clip> fit`. */
function exported(timeline: Timeline, id: string, frame: number): string[] {
  const format = formatOf(PROJECT, id)!;
  const plan = compileFrame({
    timeline: flattenTimeline(timeline, () => null, FPS),
    fps: FPS,
    sources: EXPORT_SOURCES,
    generated: GENERATED,
    resolution: PROJECT.resolution,
    variant: format,
    width: format.width,
    height: format.height,
    at: frame / FPS,
    output: "frame.png",
  });
  const clips = new Map(timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [] : track.clips)).map((clip) => [`/abs/${"asset" in clip ? clip.asset : ""}`, clip.id]));
  clips.set("/abs/gen.webm", "c_gen");
  const inputs = plan.args.flatMap((arg, i) => (plan.args[i - 1] === "-i" ? [arg] : []));
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!.split(";");
  return inputs.flatMap((path, n) => {
    const clip = clips.get(path);
    if (!clip) return [];
    const chain = graph.find((line) => line.startsWith(`[${n}:v`)) ?? "";
    return [`${clip} ${/crop=\d+:\d+:\d+:\d+/.exec(chain)?.[0] ?? "fit"}`];
  });
}

describe("the preview in a project format (ADR 0027)", () => {
  it("takes the format export resolves", () => {
    for (const { id } of projectFormats(PROJECT)) expect(formatOf(PROJECT, id)).toEqual(resolveFormat(stack("assets/talk.mp4", []), PROJECT, id)!.format);
    expect(formatOf(PROJECT, "21x9")).toBeNull();
  });

  it("covers and fits each clip as the exported frame does, in every format", () => {
    for (const { id } of projectFormats(PROJECT)) {
      for (const base of ["assets/talk.mp4", "assets/small.mp4", "assets/plate.webm"]) {
        const timeline = stack(base, UPPER);
        const shown = preview(timeline, id);
        // One frame inside each upper clip: footage, alpha video, alpha still, transformed still, keyed footage, render.
        for (const frame of [15, 75, 135, 195, 255, 315]) {
          expect.soft(previewed(shown, frame), `${id} ${base} frame ${frame}`).toEqual(exported(timeline, id, frame));
        }
      }
    }
  });

  it("cuts untransformed opaque footage and the base track; fits alpha overlays, placed, keyed and generated clips", () => {
    const shown = preview(stack("assets/plate.webm", UPPER), "9x16");
    // 1920x1080 in 1080x1920: the centre 608x1080. The base track is cut even with alpha.
    expect(previewed(shown, 15)).toEqual(["c_base crop=608:1080:656:0", "c_broll crop=608:1080:656:0"]);
    expect(previewed(shown, 75)).toEqual(["c_base crop=608:1080:656:0", "c_title fit"]);
    expect(previewed(shown, 135)).toEqual(["c_base crop=608:1080:656:0", "c_frame fit"]);
    expect(previewed(shown, 195)).toEqual(["c_base crop=608:1080:656:0", "c_logo fit"]);
    expect(previewed(shown, 255)).toEqual(["c_base crop=608:1080:656:0", "c_keyed fit"]);
    expect(previewed(shown, 315)).toEqual(["c_base crop=608:1080:656:0", "c_gen fit"]);
  });

  it("leaves the primary format as the preview without formats", () => {
    const timeline = stack("assets/talk.mp4", UPPER);
    const plain = compileProgram(viewOf(timeline), ASSETS, { resolution: PROJECT.resolution, renders: RENDERS });
    expect(preview(timeline, "16x9")).toEqual(plain);
    expect(previewed(plain, 15)).toEqual(["c_base fit", "c_broll fit"]);
  });

  it("sizes captions as export burns them: 1.3x in vertical formats other than the primary", () => {
    const transcript: Transcript = {
      schemaVersion: 1,
      asset: "assets/talk.mp4",
      assetHash: `sha256:${"0".repeat(64)}`,
      provider: "test",
      model: "test",
      words: [{ id: "w_000001", text: "hola", start: 0.2, end: 0.8 }],
      edits: {},
    };
    const captioned: Timeline = {
      ...stack("assets/talk.mp4", []),
      tracks: [{ id: "v1", kind: "video", clips: [media("c_base", "assets/talk.mp4", 0)] }, { id: "s1", kind: "subtitles", follows: "v1", style: { preset: "big-keyword" } }],
    };
    const lookup = (path: string) => (path === transcript.asset ? transcript : null);
    const sizes = projectFormats(PROJECT).map(({ id }) => {
      const format = formatOf(PROJECT, id)!;
      const [track] = scaledCaptions(subtitleTracks(captioned, lookup, FPS), format);
      const drawn = subtitleLayout(track!.style, format).fontSize;
      const plan = compileFrame({
        timeline: captioned,
        fps: FPS,
        sources: EXPORT_SOURCES,
        transcripts: new Map([[transcript.asset, transcript]]),
        resolution: PROJECT.resolution,
        variant: format,
        width: format.width,
        height: format.height,
        at: 0.5,
        output: "frame.png",
      });
      // ASS sizes a face by its ascent plus descent; the preview draws it by its em size.
      const burned = Number(/^Style: t0,[^,]+,([\d.]+),/m.exec(plan.files["subtitles.ass"]!)![1]);
      expect(burned, id).toBeCloseTo(drawn * (SUBTITLE_FONT.ascent + SUBTITLE_FONT.descent), 1);
      return [id, drawn] as const;
    });
    const by = Object.fromEntries(sizes);
    expect(by["9x16"]! / by["1x1"]!).toBeCloseTo(1.3, 1);
    expect(by["4x5"]! / by["1x1"]!).toBeCloseTo(1.3, 1);
    expect(by["16x9"]).toBe(by["1x1"]);
  });
});
