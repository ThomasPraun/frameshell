import { describe, expect, it } from "vitest";
import { liveSeconds, liveTarget } from "../src/renderer/src/preview/live.js";
import type { LayerRender, Program, VideoSpan } from "../src/renderer/src/preview/program.js";

// Seam under test: which generated clip the preview plays live (ADR 0010), where, and at what composition time.

const IDENTITY = { x: 0, y: 0, scale: 1, opacity: 1 };
const HD = { width: 1920, height: 1080 };

const rendering = (key: string | null = "k1", state: Exclude<LayerRender["state"], "ready"> = "rendering"): LayerRender => ({
  state,
  progress: 0.4,
  error: null,
  key,
});

const generated = (clip: string, render: LayerRender | null, extra: Partial<Extract<VideoSpan, { kind: "generated" }>> = {}): VideoSpan => ({
  kind: "generated",
  clip,
  type: "hyperframes",
  start: 30,
  end: 90,
  in: 15,
  render,
  size: null,
  placement: IDENTITY,
  ...extra,
});

const media = (clip: string): VideoSpan => ({
  kind: "media",
  clip,
  start: 0,
  end: 120,
  proxy: ".frameshell/proxies/a.mp4",
  in: 0,
  speed: 1,
  size: HD,
  placement: IDENTITY,
});

const program = (...layers: VideoSpan[][]): Program => ({ fps: 30, sampleRate: 48_000, resolution: HD, frames: 120, layers, audio: [] });

describe("liveTarget", () => {
  it("plays a generated clip live while its render is queued or rendering, over footage below it", () => {
    for (const state of ["queued", "rendering"] as const) {
      const target = liveTarget(program([media("c_base")], [generated("c_card", rendering("k1", state))]), 45);
      expect(target).toMatchObject({ clip: "c_card", layer: 1, key: "k1", box: { left: 0, top: 0, width: 1, height: 1 }, opacity: 1 });
    }
  });

  it("keeps the slate when the render is ready, failed, unavailable or not known yet", () => {
    expect(liveTarget(program([generated("c_card", { state: "ready", file: "x.webm" })]), 45)).toBeNull();
    expect(liveTarget(program([generated("c_card", rendering("k1", "failed"))]), 45)).toBeNull();
    expect(liveTarget(program([generated("c_card", rendering(null, "unavailable"))]), 45)).toBeNull();
    expect(liveTarget(program([generated("c_card", null)]), 45)).toBeNull();
  });

  it("only takes the topmost picture: a clip under another layer keeps its slate", () => {
    expect(liveTarget(program([generated("c_card", rendering())], [media("c_over")]), 45)).toBeNull();
    // An upper generated clip that is not live (ready, here) covers the one below too.
    expect(liveTarget(program([generated("c_card", rendering())], [generated("c_top", { state: "ready", file: "x.webm" })]), 45)).toBeNull();
    // Gaps on upper layers are transparent.
    expect(liveTarget(program([generated("c_card", rendering())], [], [generated("c_late", rendering("k2"), { start: 100, end: 110 })]), 45)).toMatchObject({
      clip: "c_card",
    });
    // Outside the clip's span: nothing.
    expect(liveTarget(program([generated("c_card", rendering())]), 95)).toBeNull();
  });

  it("places the page like a render at the project format, with the clip's opacity", () => {
    const placed = generated("c_card", rendering(), { placement: { x: 480, y: -270, scale: 0.5, opacity: 0.6 } });
    expect(liveTarget(program([placed]), 45)).toMatchObject({ box: { left: 0.5, top: 0, width: 0.5, height: 0.5 }, opacity: 0.6 });
  });

  it("addresses a clip inside a nested timeline by its flattened id", () => {
    expect(liveTarget(program([generated("c_nest/c_card", rendering())]), 45)?.clip).toBe("c_nest/c_card");
  });
});

describe("liveSeconds", () => {
  it("maps program time to composition time as the engine maps render frames: in + (t - start)", () => {
    const span = generated("c_card", rendering()) as Extract<VideoSpan, { kind: "generated" }>;
    // start 30 (1 s), in 15 (0.5 s): program 1 s shows composition 0.5 s.
    expect(liveSeconds(span, 1, 30)).toBeCloseTo(0.5);
    expect(liveSeconds(span, 2.25, 30)).toBeCloseTo(1.75);
    expect(liveSeconds({ ...span, in: 0 }, 0.5, 30)).toBe(0);
  });
});
