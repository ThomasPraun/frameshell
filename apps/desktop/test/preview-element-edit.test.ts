import { describe, expect, it } from "vitest";
import {
  adjustedBox,
  dragAdjust,
  elementEdit,
  filled,
  fragileSelector,
  holdSettled,
  idRequest,
  stored,
  topmostAt,
  withAdjust,
} from "../src/renderer/src/preview/element-edit.js";
import { createElementMode } from "../src/renderer/src/preview/element-mode.js";
import type { LayerRender, Program, VideoSpan } from "../src/renderer/src/preview/program.js";

// Seam under test: element mode's geometry and edits (ADR 0021), pure, and its shared state.

const IDENTITY = { x: 0, y: 0, scale: 1, opacity: 1 };
const HD = { width: 1920, height: 1080 };
/** The frame on screen: half the project's size. */
const SCREEN = { width: 960, height: 540 };
const FULL = { left: 0, top: 0, width: 1, height: 1 };
/** An element 192×108 page px at (192, 108): a tenth of the frame, a tenth in. */
const BOX = { left: 0.1, top: 0.1, width: 0.1, height: 0.1 };

const generated = (clip: string, render: LayerRender | null): VideoSpan => ({
  kind: "generated",
  clip,
  type: "hyperframes",
  start: 0,
  end: 60,
  in: 0,
  render,
  size: null,
  placement: IDENTITY,
});
const media = (clip: string): VideoSpan => ({ kind: "media", clip, start: 0, end: 60, proxy: "p.mp4", in: 0, speed: 1, size: HD, placement: IDENTITY });
const program = (...layers: VideoSpan[][]): Program => ({ fps: 30, sampleRate: 48_000, resolution: HD, frames: 60, layers, audio: [] });

describe("dragAdjust", () => {
  const drag = { start: filled(undefined), frame: SCREEN, page: FULL, resolution: HD, unit: 1, box: BOX };

  it("moves by whole composition px: screen px times the page's scale on screen", () => {
    expect(dragAdjust({ ...drag, kind: "move", from: { x: 100, y: 100 }, to: { x: 150, y: 80 } })).toEqual({ x: 100, y: -40, scale: 1 });
  });

  it("divides by the element's unit when the composition scales its stage to the page", () => {
    // A 3840-wide composition drawn in a 1920 page: one page px is two composition px.
    expect(dragAdjust({ ...drag, unit: 0.5, kind: "move", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } })).toMatchObject({ x: 40 });
  });

  it("follows a page placed smaller in the frame, adding to the stored move", () => {
    const half = { left: 0.25, top: 0.25, width: 0.5, height: 0.5 };
    expect(dragAdjust({ ...drag, start: { x: 5, y: 0, scale: 1.5 }, page: half, kind: "move", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } })).toEqual({
      x: 45,
      y: 40,
      scale: 1.5,
    });
  });

  it("scales about the element's centre on screen, three decimals, never below 0.01", () => {
    // Centre: (144, 81) screen px.
    expect(dragAdjust({ ...drag, kind: "scale", from: { x: 192, y: 81 }, to: { x: 240, y: 81 } })).toEqual({ x: 0, y: 0, scale: 2 });
    expect(dragAdjust({ ...drag, start: { x: 0, y: 0, scale: 2 }, kind: "scale", from: { x: 192, y: 81 }, to: { x: 160, y: 81 } }).scale).toBe(0.667);
    expect(dragAdjust({ ...drag, kind: "scale", from: { x: 192, y: 81 }, to: { x: 144, y: 81 } }).scale).toBe(0.01);
  });
});

describe("adjustedBox", () => {
  it("moves the probed box by the difference and scales it about its centre", () => {
    const box = adjustedBox(BOX, { x: 0, y: 0, scale: 1 }, { x: 192, y: -108, scale: 2 }, { page: FULL, resolution: HD, unit: 1 });
    expect(box.left).toBeCloseTo(0.15);
    expect(box.top).toBeCloseTo(-0.05);
    expect(box.width).toBeCloseTo(0.2);
    expect(box.height).toBeCloseTo(0.2);
  });
});

describe("elementEdit", () => {
  it("sets only what differs from the defaults, and removes an entry back at them", () => {
    expect(elementEdit("c1", "#title", undefined, { x: 0, y: -40, scale: 1 })).toEqual({ op: "clip.set", args: { clip: "c1", elements: { "#title": { y: -40 } } } });
    expect(elementEdit("c1", "#title", { y: -40 }, { x: 0, y: 0, scale: 1 })).toEqual({ op: "clip.set", args: { clip: "c1", elements: { "#title": null } } });
  });

  it("is null when nothing changed: a click, not a drag", () => {
    expect(elementEdit("c1", "#title", { scale: 1.2 }, { x: 0, y: 0, scale: 1.2 })).toBeNull();
    expect(elementEdit("c1", "#title", undefined, filled(undefined))).toBeNull();
  });

  it("keeps the other selectors in the sheet a drag shows", () => {
    expect(withAdjust({ "#a": { x: 1 }, "#b": { y: 2 } }, "#a", { x: 0, y: 0, scale: 1 })).toEqual({ "#b": { y: 2 } });
    expect(withAdjust({ "#b": { y: 2 } }, "#a", { x: 3, y: 0, scale: 2 })).toEqual({ "#b": { y: 2 }, "#a": { x: 3, scale: 2 } });
    expect(stored({ x: 0, y: 0, scale: 1 })).toBeNull();
  });
});

describe("fragileSelector", () => {
  it("flags selectors without an id or picking by position", () => {
    expect(fragileSelector("#title")).toBe(false);
    expect(fragileSelector("#stage > h1.title")).toBe(false);
    expect(fragileSelector("div > h1")).toBe(true);
    expect(fragileSelector("#stage > div:nth-child(2)")).toBe(true);
  });

  it("asks the agent for an id in English, naming the clip and the selector", () => {
    expect(idRequest("c_1", "div > h1")).toMatch(/^Give the element `div > h1` of clip c_1 an id .*frameshell clip set c_1 --elements/);
  });
});

describe("topmostAt and holdSettled", () => {
  const ready = (file: string): LayerRender => ({ state: "ready", file });
  const queued = (key: string): LayerRender => ({ state: "queued", progress: 0, error: null, key });

  it("says whether the clip is the topmost picture, the ADR 0010 rule live pages follow", () => {
    expect(topmostAt(program([media("m")], [generated("g", ready("a.webm"))]), 10, "g")).toBe(true);
    expect(topmostAt(program([generated("g", ready("a.webm"))], [media("m")]), 10, "g")).toBe(false);
  });

  it("holds the drag page until the new render, or its live page, is there", () => {
    const held = { clip: "g", identity: "a.webm" };
    // The saved adjustment has not reached the program yet.
    expect(holdSettled(program([generated("g", ready("a.webm"))]), 10, held, null)).toBe(false);
    // New key rendering: wait for its live page, not an older one.
    expect(holdSettled(program([generated("g", queued("k2"))]), 10, held, null)).toBe(false);
    expect(holdSettled(program([generated("g", queued("k2"))]), 10, held, { clip: "g", key: "k1" })).toBe(false);
    expect(holdSettled(program([generated("g", queued("k2"))]), 10, held, { clip: "g", key: "k2" })).toBe(true);
    // Rendered already, failed, or the clip is gone: nothing to wait for.
    expect(holdSettled(program([generated("g", ready("b.webm"))]), 10, held, null)).toBe(true);
    expect(holdSettled(program([generated("g", { state: "failed", progress: 0, error: "x", key: "k2" })]), 10, held, null)).toBe(true);
    expect(holdSettled(program([media("m")]), 10, held, null)).toBe(true);
  });
});

describe("element mode store", () => {
  it("enters one clip, keeps counts and a hold for it only, and leaves", () => {
    const mode = createElementMode();
    mode.enter("c1");
    mode.setCounts("c2", { "#a": 1 });
    expect(mode.get().counts).toBeNull();
    mode.setCounts("c1", { "#a": 0 });
    mode.hold("c1", "k1");
    expect(mode.get()).toEqual({ clip: "c1", counts: { "#a": 0 }, held: { clip: "c1", identity: "k1" } });
    mode.release();
    expect(mode.get().held).toBeNull();
    mode.enter("c2");
    expect(mode.get()).toEqual({ clip: "c2", counts: null, held: null });
    mode.leave();
    expect(mode.get().clip).toBeNull();
  });
});
