import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { type ResolvedGrain, grainOf, grainPlate, grainSeed, grainSpread, grainStrength } from "@frameshell/schema/finish";
import { describe, expect, it } from "vitest";
import { type PictureGrain, grainCell, grainDelta, mixBits } from "../src/renderer/src/preview/grain.js";
import { layerRect } from "@frameshell/schema/composite";
import { compileProgram, programAt, spanPlacement } from "../src/renderer/src/preview/program.js";

// Seam under test: a clip's grain (ADR 0043) in the preview: the program spans carry `grainOf`, and the pass's model
// (`grain.ts`, which the WebGL2 shader runs step for step) moves a picture by the spread export's plate is held to,
// `grainSpread` (packages/core/test/grain-render.test.ts holds the managed ffmpeg to the same numbers).

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

/** Grained footage, then plain footage on v1; a grained still and card on v2. */
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4, grain: { amount: 0.5, seed: 3 } },
        { id: "c_plain", type: "media", asset: TALK, start: 4, in: 10, out: 12 },
      ],
    },
    {
      id: "v2",
      kind: "video",
      clips: [
        { id: "c_logo", type: "media", asset: LOGO, start: 1, in: 0, out: 2, grain: {}, transform: { scale: 0.5 } },
        { id: "c_card", type: "hyperframes", source: "compositions/card/index.html", start: 4, duration: 2, grain: { size: 3 } },
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

const grain = (amount: number, seed = 9): ResolvedGrain => ({ amount, size: 1, seed, strength: grainStrength(amount) });

/** The deltas the pass adds to every texel of a `width` x `height` picture over frames (phases) `from` to `to`. */
function deltas(look: Omit<PictureGrain, "phase">, from: number, to: number): number[] {
  const values: number[] = [];
  for (let phase = from; phase < to; phase++) {
    for (let y = 0; y < look.crop.height; y++) for (let x = 0; x < look.crop.width; x++) values.push(grainDelta(x + look.crop.left, y + look.crop.top, { ...look, phase }));
  }
  return values;
}

function stats(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, std: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
}

describe("grain in the preview (ADR 0043)", () => {
  it("gives footage, stills and generated clips their grain with defaults and seed filled in, and nothing else one", () => {
    const program = compileProgram(view(timeline), assets, { resolution: HD });
    expect(programAt(program, 15, 0)).toMatchObject({ kind: "media", clip: "c_talk", grain: { amount: 0.5, size: 1.5, seed: 3, strength: 24 } });
    expect(programAt(program, 135, 0)).not.toHaveProperty("grain");
    expect(programAt(program, 45, 1)).toMatchObject({ kind: "still", clip: "c_logo", grain: grainOf({ id: "c_logo", type: "media", grain: {} }) });
    expect(programAt(program, 135, 1)).toMatchObject({ kind: "generated", clip: "c_card", grain: { size: 3, seed: grainSeed("c_card") } });
  });

  it("moves a picture by the mean and spread grainSpread names, sharp at one cell per pixel and softer when cells are larger", () => {
    const crop = { left: 7, top: 3, width: 96, height: 54 };
    for (const amount of [0.25, 0.5, 1]) {
      const look = grain(amount);
      const sharp = stats(deltas({ grain: look, crop, plate: { width: 96, height: 54 } }, 0, 16));
      const expected = grainSpread(look, false);
      expect(Math.abs(sharp.mean - expected.mean), `sharp mean at ${amount}`).toBeLessThan(0.25);
      expect(Math.abs(sharp.std / expected.std - 1), `sharp std at ${amount}: ${sharp.std}`).toBeLessThan(0.03);
      // Size 2 on a picture shown at its own size: half the cells, bilinear between them.
      const plate = grainPlate(2, crop, crop);
      expect(plate).toEqual({ width: 48, height: 27 });
      const soft = stats(deltas({ grain: look, crop, plate }, 0, 32));
      const smooth = grainSpread(look, true);
      expect(Math.abs(soft.mean - smooth.mean), `soft mean at ${amount}`).toBeLessThan(0.25);
      expect(Math.abs(soft.std / smooth.std - 1), `soft std at ${amount}: ${soft.std}`).toBeLessThan(0.08);
    }
  });

  it("draws the same pattern for the same seed and frame, another for the next frame or another seed", () => {
    const crop = { left: 0, top: 0, width: 32, height: 18 };
    const plate = { width: 32, height: 18 };
    const at = (seed: number, from: number) => deltas({ grain: grain(0.5, seed), crop, plate }, from, from + 1);
    expect(at(1, 5)).toEqual(at(1, 5));
    expect(at(1, 6)).not.toEqual(at(1, 5));
    expect(at(2, 5)).not.toEqual(at(1, 5));
    // Cells outside the plate read its edge, as the shader's clamp does.
    const look = { grain: grain(0.5), crop, plate, phase: 0 };
    expect(grainCell(-1, 4, look)).toBe(grainCell(0, 4, look));
    expect(grainCell(40, 40, look)).toBe(grainCell(31, 17, look));
  });

  it("sizes the plate from the span's unkeyed placement, so a zoom key never changes the cells of a frame", () => {
    const zooming: Timeline = {
      ...timeline,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c_zoom",
              type: "media",
              asset: TALK,
              start: 0,
              in: 0,
              out: 4,
              transform: { scale: 0.5 },
              grain: { size: 2 },
              keys: { scale: [{ at: 0, value: 0.5 }, { at: 2, value: 1 }] },
            },
          ],
        },
      ],
    };
    const program = compileProgram(view(zooming), assets, { resolution: HD });
    const span = programAt(program, 0, 0);
    if (span?.kind !== "media" || !span.grain) throw new Error("expected a grained media span");
    // What the engine feeds `Part.fixed` and `grainPlate` from: the plate follows `span.placement`, never `spanPlacement`.
    const plateAt = (placement: typeof span.placement) => {
      const rect = layerRect(span.size!, HD, HD, placement);
      return grainPlate(span.grain!.size, { width: rect.width, height: rect.height }, span.size!);
    };
    const first = spanPlacement(span, 0, FPS);
    const zoomed = spanPlacement(span, 45, FPS);
    expect(zoomed.scale).toBeGreaterThan(first.scale);
    // The keyed layer is bigger, so sizing from it would give another plate; the unkeyed one gives export's.
    expect(plateAt(zoomed)).not.toEqual(plateAt(span.placement));
    expect(plateAt(span.placement)).toEqual(grainPlate(2, { width: 960, height: 540 }, { width: 1920, height: 1080 }));
    const later = programAt(program, 45, 0);
    expect(later && "placement" in later ? later.placement : null).toEqual(span.placement);
  });

  it("mixes bits as the shader's uint arithmetic does", () => {
    // lowbias32 in unsigned 32-bit arithmetic (computed apart from this code); a negative input is its 32 bits.
    expect([mixBits(0), mixBits(1), mixBits(0xffffffff), mixBits(12345)]).toEqual([0, 0x688990c0, 0x6768824a, 0x912efcf7]);
    expect(mixBits(-1)).toBe(mixBits(0xffffffff));
  });
});
