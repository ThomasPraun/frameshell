import { type ExportSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { compileProgram, letterboxOverlay } from "../src/renderer/src/preview/program.js";
import { viewsInFormat } from "../src/renderer/src/preview/useProgram.js";

// Seam under test: the preview's letterbox overlay (ADR 0043) against the export compiler on the same timeline: the
// panel's bars, scaled to the export frame, are the rectangles `drawbox` paints; a format other than the primary has none.

const TALK = "assets/talk.mp4";

const ASSET: AssetInfo = {
  path: TALK,
  kind: "media",
  hash: "sha256:talk",
  state: "ready",
  error: null,
  media: {
    duration: 600,
    format: "mov,mp4",
    video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false },
    audio: { codec: "aac", sampleRate: 48000, channels: 1 },
  },
  proxy: ".frameshell/proxies/talk.mp4",
  sidecar: { path: ".frameshell/proxies/talk.pcm", format: "s16le", sampleRate: 48000, channels: 1 },
  waveform: null,
  thumbnails: null,
};
const SOURCES = new Map<string, ExportSource>([[TALK, { path: "/abs/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 600 }]]);

function timeline(aspect: number): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4 }] }],
    letterbox: { aspect },
  };
}

/** `timeline` as `timeline.show` returns it: clips with their derived `end`, the letterbox as stored. */
function viewOf(stored: Timeline): TimelineView {
  return {
    timeline: stored.id,
    path: `timelines/${stored.id}.json`,
    revision: stored.revision,
    fps: 30,
    duration: 4,
    tracks: [{ id: "v1", kind: "video", name: null, follows: null, clips: [{ id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4, end: 4 }] }],
    ...(stored.letterbox ? { letterbox: stored.letterbox } : {}),
    problems: [],
  } as unknown as TimelineView;
}

/** The bars `drawbox` paints in a capture of `stored` at `width`x`height`. */
function exportBars(stored: Timeline, width: number, height: number): { left: number; top: number; width: number; height: number }[] {
  const plan = compileFrame({ timeline: stored, fps: 30, sources: SOURCES, resolution: { width: 1920, height: 1080 }, width, height, at: 1, output: "/out/f.png" });
  return [...plan.args.join(" ").matchAll(/drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+)/g)].map((m) => ({ left: +m[1]!, top: +m[2]!, width: +m[3]!, height: +m[4]! }));
}

describe("preview letterbox (ADR 0043)", () => {
  it("draws the bars export paints, at the project size and scaled to another capture size", () => {
    for (const aspect of [2.39, 1.85, 4 / 3, 1]) {
      const stored = timeline(aspect);
      const program = compileProgram(viewOf(stored), new Map([[TALK, ASSET]]), { resolution: { width: 1920, height: 1080 } });
      expect(program.letterbox).toEqual({ aspect });
      for (const [width, height] of [[1920, 1080], [1280, 720]] as const) {
        const shown = letterboxOverlay(program, { width, height }).map((bar) => ({
          left: Math.round(bar.left * width),
          top: Math.round(bar.top * height),
          width: Math.round(bar.width * width),
          height: Math.round(bar.height * height),
        }));
        expect(shown.length, `${aspect} at ${width}x${height}`).toBeGreaterThan(0);
        expect(shown, `${aspect} at ${width}x${height}`).toEqual(exportBars(stored, width, height));
      }
    }
  });

  it("draws none without a letterbox, and none in a format other than the primary, as export renders it", () => {
    const { letterbox: _letterbox, ...bare } = timeline(2.39);
    expect(letterboxOverlay(compileProgram(viewOf(bare), new Map([[TALK, ASSET]])), { width: 1920, height: 1080 })).toEqual([]);
    const { view } = viewsInFormat(viewOf(timeline(2.39)), new Map(), "9x16");
    const program = compileProgram(view!, new Map([[TALK, ASSET]]), { resolution: { width: 1920, height: 1080 } });
    expect(program).not.toHaveProperty("letterbox");
    expect(letterboxOverlay(program, { width: 1080, height: 1920 })).toEqual([]);
  });
});
