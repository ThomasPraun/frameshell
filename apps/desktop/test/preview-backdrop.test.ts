import { type ExportSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, ClipRenderInfo, TimelineView } from "@frameshell/protocol";
import { GLASS, type Timeline } from "@frameshell/schema";
import { backdropLayer, backdropMatrix } from "@frameshell/schema/effects";
import { describe, expect, it } from "vitest";
import { canvasBackdrop } from "../src/renderer/src/preview/backdrop.js";
import { compileProgram, programAt } from "../src/renderer/src/preview/program.js";

// Seam under test: a generated clip's backdrop (ADR 0031) in the preview program and the engine's canvas steps,
// against the export compiler's graph for the same timeline and output size.

const FPS = 30;
const HD = { width: 1920, height: 1080 };
const TALK = "assets/talk.mp4";
const RENDER = ".frameshell/cache/clips/k1.webm";

const talk: AssetInfo = {
  path: TALK,
  kind: "media",
  hash: "sha256:talk",
  state: "ready",
  error: null,
  media: { duration: 600, format: "mov,mp4", video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false }, audio: null },
  proxy: ".frameshell/proxies/talk.mp4",
  sidecar: null,
  waveform: null,
  thumbnails: null,
};

const ready = (clip: string, track: string): ClipRenderInfo => ({
  clip,
  track,
  type: "hyperframes",
  source: null,
  state: "ready",
  key: `k-${clip}`,
  file: RENDER,
  hasAlpha: true,
  width: 1920,
  height: 1080,
  duration: 2,
  job: null,
  progress: 1,
  error: null,
});

/** Footage on v1 with a glass card over it on v2 from 1 s to 3 s, and a glass card on the bottom track after the footage. */
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4 },
        { id: "c_end", type: "hyperframes", source: "compositions/end/index.html", start: 4, duration: 1, backdrop: GLASS },
      ],
    },
    {
      id: "v2",
      kind: "video",
      clips: [{ id: "c_card", type: "hyperframes", source: "compositions/card/index.html", start: 1, duration: 2, transform: { x: 200, scale: 0.5 }, backdrop: GLASS }],
    },
  ],
};

function view(source: Timeline): TimelineView {
  const tracks = source.tracks.map((track) => ({
    ...track,
    name: null,
    follows: null,
    clips: "clips" in track ? track.clips.map((clip) => ({ ...clip, end: clip.start + ("duration" in clip && clip.duration ? clip.duration : 4) })) : [],
  }));
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
}

const renders = new Map([
  ["c_card", ready("c_card", "v2")],
  ["c_end", ready("c_end", "v1")],
]);
const program = compileProgram(view(timeline), new Map([[TALK, talk]]), { renders, resolution: HD });

const sources = new Map<string, ExportSource>([[TALK, { path: "/p/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: false }]]);
const generated = new Map(["c_card", "c_end"].map((id) => [id, { path: `/p/${RENDER}`, hasAlpha: true, width: 1920, height: 1080 }]));
const exportFrame = (at: number, width: number, height: number) =>
  compileFrame({ timeline, fps: FPS, sources, generated, resolution: HD, width, height, at, output: "/out/f.png" }).args.join(" ");

describe("backdrop in the preview (ADR 0031)", () => {
  it("carries the glass on the upper track's span only, as export draws it on upper layers only", () => {
    expect(programAt(program, 45, 1)).toMatchObject({ kind: "generated", clip: "c_card", glass: GLASS });
    const bottom = programAt(program, 135, 0);
    expect(bottom).toMatchObject({ kind: "generated", clip: "c_end" });
    expect(bottom).not.toHaveProperty("glass");
    expect(exportFrame(4.5, 1920, 1080)).not.toContain("gblur");
  });

  it("draws the same sigma, saturation and scrim as export's graph at the same output size", () => {
    for (const [width, height] of [
      [1920, 1080],
      [960, 540],
    ] as const) {
      const layer = backdropLayer(GLASS, { width, height }, HD);
      const graph = exportFrame(1.5, width, height);
      const steps = canvasBackdrop(layer);
      // Canvas: blur(σ) saturate(s), then black at `dim`. Export: gblur σ, then the saturate matrix times 1 - dim.
      expect(steps).toEqual({ filter: `blur(${layer.sigma}px) saturate(${GLASS.saturate})`, dim: GLASS.dim });
      expect(graph).toContain(`gblur=sigma=${layer.sigma}`);
      const mixer = /\[bb0\]format=gbrp,gblur=sigma=[\d.]+:steps=\d+,colorchannelmixer=([^,]+),format=rgba/.exec(graph)?.[1];
      const coefficients = mixer!.split(":").map((pair) => Number(pair.split("=")[1]));
      expect(coefficients).toEqual(backdropMatrix(layer));
      expect(graph).toContain(`lutrgb=a='gt(val,${layer.threshold})*255'`);
    }
    expect(backdropLayer(GLASS, { width: 960, height: 540 }, HD).sigma).toBe(23);
  });

  it("leaves out canvas steps that change nothing", () => {
    expect(canvasBackdrop(backdropLayer({ blur: 0 }, HD, HD))).toEqual({ filter: "none", dim: 0 });
    expect(canvasBackdrop(backdropLayer({ blur: 10, saturate: 1 }, HD, HD))).toEqual({ filter: "blur(10px)", dim: 0 });
  });
});
