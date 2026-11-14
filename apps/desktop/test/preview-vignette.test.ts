import { type ExportSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { vignetteOf } from "@frameshell/schema/finish";
import { describe, expect, it } from "vitest";
import { compileProgram, programAt } from "../src/renderer/src/preview/program.js";

// Seam under test: a clip's vignette (ADR 0043) in the preview program, against the export compiler on the same
// timeline: the spans carry `vignetteOf`, and in a covering format the crop the pass darkens is the plate's size.
// The shader that evaluates it is checked in e2e `vignette-preview.spec.ts`.

const FPS = 30;
const HD = { width: 1920, height: 1080 };
const TALK = "assets/talk.mp4";
const LOGO = "assets/logo.png";

const asset = (path: string, still: boolean): AssetInfo => ({
  path,
  kind: "media",
  hash: `sha256:${path}`,
  state: "ready",
  error: null,
  media: { duration: still ? 0 : 600, format: still ? "png_pipe" : "mov,mp4", video: { codec: still ? "png" : "h264", width: 1920, height: 1080, fps: 30, vfr: false, still }, audio: null },
  proxy: still ? null : ".frameshell/proxies/talk.mp4",
  sidecar: null,
  waveform: null,
  thumbnails: null,
});
const assets = new Map([
  [TALK, asset(TALK, false)],
  [LOGO, asset(LOGO, true)],
]);

const LENS = { strength: 0.5, radius: 0.9 };

/** Vignetted footage, then plain footage, then footage with a strength of 0 on v1; a vignetted still and card on v2. */
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4, vignette: LENS },
        { id: "c_plain", type: "media", asset: TALK, start: 4, in: 10, out: 6 + 10 - 4 },
        { id: "c_off", type: "media", asset: TALK, start: 6, in: 20, out: 22, vignette: { strength: 0 } },
      ],
    },
    {
      id: "v2",
      kind: "video",
      clips: [
        { id: "c_logo", type: "media", asset: LOGO, start: 1, in: 0, out: 2, vignette: {}, transform: { scale: 0.5 } },
        { id: "c_card", type: "hyperframes", source: "compositions/card/index.html", start: 4, duration: 2, vignette: { softness: 0 } },
      ],
    },
  ],
};

function view(source: Timeline): TimelineView {
  const tracks = source.tracks.map((track) => ({
    ...track,
    name: null,
    follows: null,
    clips: "clips" in track ? track.clips.map((clip) => ({ ...clip, end: clip.start + ("out" in clip ? clip.out - clip.in : (clip as { duration: number }).duration) })) : [],
  }));
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
}

describe("vignette in the preview (ADR 0043)", () => {
  it("gives footage, stills and generated clips their vignette with defaults filled in, and nothing else one", () => {
    const program = compileProgram(view(timeline), assets, { resolution: HD });
    expect(programAt(program, 15, 0)).toMatchObject({ kind: "media", clip: "c_talk", vignette: { strength: 0.5, radius: 0.9, softness: 0.6 } });
    expect(programAt(program, 135, 0)).not.toHaveProperty("vignette");
    expect(programAt(program, 195, 0)).not.toHaveProperty("vignette");
    expect(programAt(program, 45, 1)).toMatchObject({ kind: "still", clip: "c_logo", vignette: vignetteOf({ type: "media", vignette: {} }) });
    expect(programAt(program, 135, 1)).toMatchObject({ kind: "generated", clip: "c_card", vignette: { strength: 0.35, radius: 1, softness: 0 } });
  });

  it("darkens the pixels a covering format shows: the crop is the size of export's plate", () => {
    const vertical = { cover: true, captionScale: 1, width: 1080, height: 1920 };
    const program = compileProgram(view(timeline), assets, { resolution: HD, format: vertical });
    const span = programAt(program, 15, 0) as { cover?: { width: number; height: number }; vignette?: object };
    expect(span.vignette).toBeDefined();
    const sources = new Map<string, ExportSource>([[TALK, { path: "/p/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: false }]]);
    const footage: Timeline = { ...timeline, tracks: [timeline.tracks[0]!] };
    const graph = compileFrame({ timeline: footage, fps: FPS, sources, resolution: HD, width: 1080, height: 1920, at: 0.5, output: "/out/f.png", variant: vertical }).args.join(" ");
    const [, width, height] = /color=c=black:s=(\d+)x(\d+):r=[\d/]+,trim=end_frame=1,format=gbrap,geq=/.exec(graph)!;
    expect({ width: Number(width), height: Number(height) }).toEqual({ width: span.cover!.width, height: span.cover!.height });
  });
});
