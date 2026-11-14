import { type ExportSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Clip, Timeline, TransitionShape } from "@frameshell/schema";
import { dissolveProgress, flattenTimeline } from "@frameshell/schema/composite";
import { shapeProgress } from "@frameshell/schema/transitions";
import { describe, expect, it } from "vitest";
import { compileProgram, programAt, spanShape } from "../src/renderer/src/preview/program.js";

// Seam under test: shaped dissolves on upper tracks and inside nested clips (ADR 0030 slice 3), preview against the
// export compiler on the same timeline: on every frame both cut the same number of pictures, at the same progress.
// The geometry each draws for a progress is pinned on both sides against `shapeAt` (export-animation, preview-transitions).

const FPS = 30;
const TALK = "assets/talk.mp4";
const LOGO = "assets/logo.png";

function asset(path: string, still = false): AssetInfo {
  const key = path.replace(/\W/g, "");
  return {
    path,
    kind: "media",
    hash: `sha256:${key}`,
    state: "ready",
    error: null,
    media: {
      duration: still ? null : 600,
      format: still ? "png_pipe" : "mov,mp4",
      video: { codec: still ? "png" : "h264", width: 1920, height: 1080, fps: still ? 0 : 30, vfr: false, still },
      audio: still ? null : { codec: "aac", sampleRate: 48000, channels: 1 },
    },
    proxy: still ? null : `.frameshell/proxies/${key}.mp4`,
    sidecar: still ? null : { path: `.frameshell/proxies/${key}.pcm`, format: "s16le", sampleRate: 48000, channels: 1 },
    waveform: null,
    thumbnails: null,
  };
}

const ASSETS = new Map([
  [TALK, asset(TALK)],
  [LOGO, asset(LOGO, true)],
]);
const SOURCES = new Map<string, ExportSource>([
  [TALK, { path: "/abs/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 600 }],
  [LOGO, { path: "/abs/logo.png", video: { codec: "png", still: true, width: 1920, height: 1080 }, audio: false }],
]);

const media = (id: string, asset: string, start: number, inS: number, out: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset, start, in: inS, out, ...extra }) as Clip;

/** `timeline` as `timeline.show` returns it: clips with their derived `end`. */
function viewOf(timeline: Timeline, duration: number | null = null): TimelineView {
  const tracks = timeline.tracks.map((track) => {
    if (track.kind === "subtitles" || track.kind === "program") throw new Error("not here");
    const clips = track.clips.map((clip) => {
      if (clip.type === "timeline") return { ...clip, end: clip.start + clip.duration! };
      const { start, in: inS, out } = clip as Clip & { in: number; out: number };
      return { ...clip, end: start + (out - inS) };
    });
    return { ...track, name: null, follows: null, clips };
  });
  return { timeline: timeline.id, path: `timelines/${timeline.id}.json`, revision: 1, fps: FPS, duration, tracks, problems: [] } as unknown as TimelineView;
}

const timeline = (id: string, tracks: Timeline["tracks"]): Timeline => ({ schemaVersion: 1, id, revision: 1, tracks });

/** Progress of each picture the preview cuts with a mask (strip, circle, slats, cells) or scales with a zoom at `frame`, and how many show outside one. */
function previewCuts(view: TimelineView, nested: ReadonlyMap<string, TimelineView>, frame: number): { progress: number[]; outside: number } {
  const program = compileProgram(view, ASSETS, { nested });
  const progress: number[] = [];
  let outside = 0;
  program.layers.forEach((_, layer) => {
    const span = programAt(program, frame, layer);
    if (!span || (span.kind !== "media" && span.kind !== "still" && span.kind !== "generated")) return;
    const shape = spanShape(span, frame, FPS);
    if (!shape || (shape.clip === null && !shape.circle && !shape.slats && !shape.grid && !shape.zoom)) return;
    const t = frame / FPS;
    const { motion } = span;
    const playing = [motion?.dissolveIn, motion?.dissolveOut, motion?.hostShape].find((d) => d?.shape && t >= d.at - d.half && t < d.at + d.half)!;
    progress.push(shapeProgress(dissolveProgress(playing.at, playing.half, t)));
    if (shape.outside) outside++;
  });
  return { progress: progress.map(round).sort(), outside };
}

/** The same from the export's capture of `frame`: every `geq` mask and zoom scale, its progress from `(T-a)/b`, and how many keep the outside of a circle, slats or cells. */
function exportCuts(flat: Timeline, frame: number): { progress: number[]; outside: number } {
  const plan = compileFrame({ timeline: flat, fps: FPS, sources: SOURCES, resolution: { width: 1920, height: 1080 }, width: 960, height: 540, at: frame / FPS, output: "f.png" });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
  const masks = [...graph.matchAll(/:a='(if\((?:lt|gte)\((hypot|mod)?[^']*?\(T-([\d.]+)\)\/([\d.]+)\)[^']*)'/g)];
  const zooms = [...graph.matchAll(/scale=w='max\(1,floor\([^']*?\(t-([\d.]+)\)\/([\d.]+)\)/g)];
  const t = frame / FPS;
  const progress = [
    ...masks.map((mask) => round(shapeProgress((t - Number(mask[3])) / Number(mask[4])))),
    ...zooms.map((zoom) => round(shapeProgress((t - Number(zoom[1])) / Number(zoom[2])))),
  ];
  // Circles, slats and cells are masks of their own kind; a wipe's complement is a strip, not an outside.
  const outside = masks.filter((mask) => mask[2] && mask[1]!.endsWith(",0,alpha(X,Y))")).length;
  return { progress: progress.sort(), outside };
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function expectParity(root: Timeline, scenes: Record<string, { timeline: Timeline; duration: number }> = {}): void {
  const nested = new Map(Object.entries(scenes).map(([path, scene]) => [path, viewOf(scene.timeline, scene.duration)]));
  const flat = flattenTimeline(root, (source) => scenes[source]?.timeline ?? null, FPS);
  const view = viewOf(root);
  let cut = 0;
  for (let frame = 0; frame < 150; frame++) {
    const preview = previewCuts(view, nested, frame);
    expect(preview, `frame ${frame}`).toEqual(exportCuts(flat, frame));
    cut += preview.progress.length;
  }
  expect(cut).toBeGreaterThan(0);
}

/** A still on v0; on v1 two talk clips, the second coming in at 2 s by `shape` (1 s), then a third by `next` at 4 s. */
const upper = (shape: TransitionShape, next: TransitionShape) =>
  timeline("main", [
    { id: "v0", kind: "video", clips: [media("bg", LOGO, 0, 0, 5)] },
    {
      id: "v1",
      kind: "video",
      clips: [
        media("a", TALK, 0, 10, 12, { transform: { scale: 0.5, x: 200 } }),
        media("b", TALK, 2, 20, 4 + 20 - 2, { dissolve: 1, shape, transform: { scale: 0.5, x: 200 } }),
        media("c", TALK, 4, 30, 31, { dissolve: 0.4, shape: next }),
      ],
    },
  ]);

describe("shaped dissolves in preview and export (ADR 0030 slice 3)", () => {
  it("cut both pictures of a wipe and an iris on an upper track on the same frames, the outgoing one by the inverse", () => {
    expectParity(upper({ kind: "wipe", direction: "down" }, { kind: "iris", origin: [0.6, 0.2, 0.8, 0.4] }));
    expectParity(upper({ kind: "iris" }, { kind: "wipe", direction: "right" }));
  });

  it("cut or scale both pictures of a zoom, slats and a grid on an upper track on the same frames", () => {
    expectParity(upper({ kind: "zoom", origin: [0.6, 0.2, 0.8, 0.4] }, { kind: "slats", direction: "up", count: 6 }));
    expectParity(upper({ kind: "grid", count: 10 }, { kind: "zoom" }));
    expectParity(upper({ kind: "slats" }, { kind: "grid" }));
  });

  it("carry a nested clip's wipe to the clip opening its window and to its upper tracks", () => {
    const scene = timeline("scene", [
      { id: "v1", kind: "video", clips: [media("cam", TALK, 0, 40, 46)] },
      { id: "v2", kind: "video", clips: [media("badge", LOGO, 0, 0, 6, { transform: { x: 500, scale: 0.3 } })] },
    ]);
    const host = (shape: TransitionShape): Clip =>
      ({ id: "n", type: "timeline", source: "timelines/scene.json", start: 2, in: 0.5, duration: 3, dissolve: 0.6, shape, keys: { scale: [{ at: 0.5, value: 1 }, { at: 3.5, value: 1.2 }] } }) as Clip;
    const scenes = { "timelines/scene.json": { timeline: scene, duration: 6 } };
    for (const shape of [{ kind: "wipe", direction: "left" }, { kind: "iris", origin: [0.1, 0.1, 0.3, 0.3] }, { kind: "slats", count: 4 }, { kind: "grid", count: 6 }, { kind: "zoom" }] as TransitionShape[]) {
      const root = timeline("main", [{ id: "v1", kind: "video", clips: [media("a", TALK, 0, 10, 12), host(shape)] }]);
      expectParity(root, scenes);
      // Half way in (2 s), the camera and the badge are both cut (a zoom also scales the clip before).
      expect(previewCuts(viewOf(root), new Map([["timelines/scene.json", viewOf(scene, 6)]]), 61).progress).toHaveLength(shape.kind === "zoom" ? 3 : 2);
    }
  });
});
