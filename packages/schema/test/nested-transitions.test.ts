import { describe, expect, it } from "vitest";
import {
  type Clip,
  type Timeline,
  clipHandles,
  composePlacement,
  flattenTimeline,
  gainAt,
  hasPictureKeys,
  hostFades,
  isKeyed,
  nestingOf,
  placementAt,
} from "../src/index.js";

const timeline = (id: string, tracks: Timeline["tracks"]): Timeline => ({ schemaVersion: 1, id, revision: 0, tracks });
const clipsOf = (flat: Timeline, track: string): Clip[] => (flat.tracks.find((candidate) => candidate.id === track) as { clips: Clip[] }).clips;
const byId = (flat: Timeline, track: string, id: string): Clip => clipsOf(flat, track).find((clip) => clip.id === id)!;
/** `hostFades` of `clip` with lengths to 6 decimals (whole frames carry float noise). */
const fadesOf = (clip: Clip) => hostFades(clip).map((fade) => ({ ...fade, fadeIn: Number(fade.fadeIn.toFixed(6)), fadeOut: Number(fade.fadeOut.toFixed(6)) }));
const times = (from: number, to: number) => Array.from({ length: 41 }, (_, i) => from + ((to - from) * i) / 40);

// Scene, 8 s: the camera (fades in at 0), then a second shot dissolving in at 4 s and fading out at 8 s; a title
// with opacity keys on V2 from 1 s to 4 s; music with gain keys on A1.
const c1: Clip = { id: "c1", type: "media", asset: "assets/cam.mp4", start: 0, in: 10, out: 14, fadeIn: 0.5 };
const c2: Clip = { id: "c2", type: "media", asset: "assets/cam.mp4", start: 4, in: 20, out: 24, dissolve: 1, fadeOut: 0.5 };
const title: Clip = {
  id: "title",
  type: "media",
  asset: "assets/title.png",
  start: 1,
  in: 0,
  out: 3,
  transform: { x: 100, scale: 0.5 },
  keys: {
    opacity: [
      { at: 0.5, value: 0.2, ease: "in-out" },
      { at: 2.5, value: 1 },
    ],
  },
};
const music: Clip = {
  id: "music",
  type: "media",
  asset: "assets/music.wav",
  start: 0,
  in: 0,
  out: 8,
  keys: {
    gain: [
      { at: 1, value: -20 },
      { at: 5, value: -8, ease: "out" },
    ],
  },
};
const scene = timeline("scene", [
  { id: "v1", kind: "video", clips: [c1, c2] },
  { id: "v2", kind: "video", clips: [title] },
  { id: "a1", kind: "audio", clips: [music] },
]);
// At 5 s, after a 5 s clip it butts: scene seconds 2 to 6, zooming out, 100 px right, 6 dB down, with every edge.
const host: Clip = {
  id: "n",
  type: "timeline",
  source: "timelines/scene.json",
  start: 5,
  in: 2,
  duration: 4,
  transform: { x: 100 },
  audio: { gain: -6 },
  dissolve: 2,
  fadeIn: 0.3,
  fadeOut: 1,
  keys: {
    scale: [
      { at: 2, value: 1, ease: "in" },
      { at: 6, value: 0.5 },
    ],
    gain: [
      { at: 3, value: 0 },
      { at: 5, value: -12 },
    ],
  },
};
const main = timeline("main", [{ id: "v1", kind: "video", clips: [{ id: "a", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5 }, host] }]);
const resolve = (source: string) => (source === "timelines/scene.json" ? scene : null);
/** Scene second playing at main second `t` inside the host. */
const sceneTime = (t: number) => t - 5 + 2;

describe("nested clips with keys and edges (ADR 0018 decision 9)", () => {
  const flat = flattenTimeline(main, resolve, 10);

  it("composes the host's keys with each clip's placement and gain at every time", () => {
    for (const t of times(5, 9)) {
      const cam = t < 7 ? byId(flat, "v1", "n/c1") : byId(flat, "v1", "n/c2");
      expect(placementAt(cam, t), `camera at ${t}`).toEqual(composePlacement(placementAt(host, t), placementAt(t < 7 ? c1 : c2, sceneTime(t))));
      expect(gainAt(byId(flat, "v1/a1", "n/music"), t), `music at ${t}`).toBeCloseTo(gainAt(host, t) + gainAt(music, sceneTime(t)), 9);
    }
    for (const t of times(5, 7)) {
      const expected = composePlacement(placementAt(host, t), placementAt(title, sceneTime(t)));
      const actual = placementAt(byId(flat, "v1/2", "n/title"), t);
      for (const prop of ["x", "y", "scale", "opacity"] as const) expect(actual[prop], `title ${prop} at ${t}`).toBeCloseTo(expected[prop], 9);
    }
    expect(hasPictureKeys(byId(flat, "v1", "n/c1"))).toBe(true);
    expect(isKeyed(byId(flat, "v1/a1", "n/music"), "scale")).toBe(false);
    // Sound has no picture: no transform, no picture keys of the host.
    expect(nestingOf(byId(flat, "v1/a1", "n/music"))!.hosts[0]).not.toHaveProperty("transform");
  });

  it("keeps an inner clip's transition fields only at its real edges, not where the window cuts it", () => {
    const first = byId(flat, "v1", "n/c1");
    const second = byId(flat, "v1", "n/c2");
    // c1 is cut at the window's start: its fade in is gone; the host's dissolve takes its place there.
    expect(first.fadeIn).toBeUndefined();
    expect(first.dissolve).toBe(2);
    // c2's dissolve is at its real start (scene 4 s, inside the window); its fade out is cut off at scene 6 s.
    expect(second.dissolve).toBe(1);
    expect(second.fadeOut).toBeUndefined();
  });

  it("gives every layer and sound the host's fades, and the extra ones a fade in for its dissolve", () => {
    // fadeIn 0.3, fadeOut 1 (half of 4 s allows it); a 2 s dissolve after a butted clip: 1 s in after the cut.
    const own = { start: 5, end: 9, fadeIn: 0.3, fadeOut: 1 };
    expect(fadesOf(byId(flat, "v1", "n/c1"))).toEqual([own]);
    expect(fadesOf(byId(flat, "v1", "n/c2"))).toEqual([own]);
    expect(fadesOf(byId(flat, "v1/2", "n/title"))).toEqual([{ ...own, fadeIn: 1 }]);
    expect(fadesOf(byId(flat, "v1/a1", "n/music"))).toEqual([{ ...own, fadeIn: 1 }]);
  });

  it("limits handles at the window's edges to the nested timeline's seconds outside it", () => {
    const context = { fps: 10, sourceDuration: () => 100 };
    // c1 plays camera 12 s on: 12 s of its own before, but only scene seconds 0 to 2 before the window.
    expect(clipHandles(byId(flat, "v1", "n/c1"), context).before).toBe(2);
    // c2 ends the window at scene 6 s; the scene runs to 8 s.
    expect(clipHandles(byId(flat, "v1", "n/c2"), context).after).toBe(2);
    // Real edges keep their own media.
    expect(clipHandles(byId(flat, "v1", "n/c2"), context).before).toBe(20);
  });

  it("fades the host's own track in too when no clip starts its window there", () => {
    const late = timeline("late", [
      { id: "v1", kind: "video", clips: [{ id: "c", type: "media", asset: "assets/cam.mp4", start: 3, in: 0, out: 2 }] },
      { id: "v2", kind: "video", clips: [{ id: "t", type: "media", asset: "assets/title.png", start: 0, in: 0, out: 5 }] },
    ]);
    const gap = timeline("main", [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "a", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5 },
          { id: "n", type: "timeline", source: "timelines/late.json", start: 5, duration: 5, dissolve: 1 },
        ],
      },
    ]);
    const out = flattenTimeline(gap, (source) => (source === "timelines/late.json" ? late : null), 10);
    expect(byId(out, "v1", "n/c").dissolve).toBeUndefined();
    expect(fadesOf(byId(out, "v1", "n/c"))).toEqual([{ start: 5, end: 10, fadeIn: 0.5, fadeOut: 0 }]);
    expect(fadesOf(byId(out, "v1/2", "n/t"))).toEqual([{ start: 5, end: 10, fadeIn: 0.5, fadeOut: 0 }]);
  });

  it("composes keys without fps, but records edges and handles only when flattening for playback", () => {
    const loose = flattenTimeline(main, resolve);
    const cam = byId(loose, "v1", "n/c1");
    expect(cam.dissolve).toBeUndefined();
    expect(hostFades(cam)).toEqual([]);
    expect(nestingOf(cam)).not.toHaveProperty("before");
    expect(placementAt(cam, 6)).toEqual(placementAt(byId(flat, "v1", "n/c1"), 6));
  });

  it("composes a keyed inner clip under a static transform at each time, not into its transform", () => {
    const keyed = timeline("keyed", [
      {
        id: "v1",
        kind: "video",
        clips: [
          {
            id: "k",
            type: "media",
            asset: "assets/title.png",
            start: 0,
            in: 0,
            out: 4,
            keys: {
              x: [
                { at: 0, value: -200 },
                { at: 4, value: 200 },
              ],
            },
          },
        ],
      },
    ]);
    const moved: Clip = { id: "m", type: "timeline", source: "timelines/keyed.json", start: 1, transform: { x: 50, scale: 0.5 } };
    const out = flattenTimeline(timeline("main", [{ id: "v1", kind: "video", clips: [moved] }]), (source) => (source === "timelines/keyed.json" ? keyed : null));
    const inner = (keyed.tracks[0] as { clips: Clip[] }).clips[0]!;
    for (const t of times(1, 5)) expect(placementAt(byId(out, "v1", "m/k"), t)).toEqual(composePlacement(placementAt(moved, t), placementAt(inner, t - 1)));
  });

  it("folds hosts outermost first through two levels of nesting, moved to the root's seconds", () => {
    const mid = timeline("mid", [{ id: "v1", kind: "video", clips: [{ ...host, id: "inner", start: 1, in: 2, duration: 3 }] }]);
    const outer: Clip = { id: "outer", type: "timeline", source: "timelines/mid.json", start: 10, in: 0, duration: 4, transform: { y: 30, scale: 0.5 } };
    const root = timeline("main", [{ id: "v1", kind: "video", clips: [outer] }]);
    const out = flattenTimeline(root, (source) => (source === "timelines/mid.json" ? mid : resolve(source)), 10);
    const cam = byId(out, "v1", "outer/inner/c1");
    expect(nestingOf(cam)!.hosts.map((entry) => [entry.id, entry.start, entry.end])).toEqual([
      ["outer", 10, 14],
      ["outer/inner", 11, 14],
    ]);
    const innerHost = { ...host, start: 1, in: 2, duration: 3 };
    for (const t of times(11, 13)) {
      const midTime = t - 10;
      const expected = composePlacement(placementAt(outer, t), composePlacement(placementAt(innerHost, midTime), placementAt(c1, midTime - 1 + 2)));
      const actual = placementAt(cam, t);
      for (const prop of ["x", "y", "scale", "opacity"] as const) expect(actual[prop], `${prop} at ${t}`).toBeCloseTo(expected[prop], 9);
    }
  });

  it("records plain data: a JSON or structuredClone copy evaluates the same", () => {
    const copies = [JSON.parse(JSON.stringify(flat)) as Timeline, structuredClone(flat)];
    for (const copy of copies) {
      for (const t of times(5, 9)) {
        expect(placementAt(byId(copy, "v1/2", "n/title"), Math.min(t, 6.9))).toEqual(placementAt(byId(flat, "v1/2", "n/title"), Math.min(t, 6.9)));
        expect(gainAt(byId(copy, "v1/a1", "n/music"), t)).toBe(gainAt(byId(flat, "v1/a1", "n/music"), t));
      }
    }
  });
});
