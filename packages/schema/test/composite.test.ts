import { describe, expect, it } from "vitest";
import { type Timeline, composePlacement, flattenTimeline, layerRect, placementOf } from "../src/index.js";

describe("layer placement", () => {
  it("fills defaults: centered, fitted, opaque", () => {
    expect(placementOf(undefined)).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 });
    expect(placementOf({ scale: 0.5 })).toEqual({ x: 0, y: 0, scale: 0.5, opacity: 1 });
  });

  it("fits the source into the output like the base track, then scales about the center", () => {
    const project = { width: 1920, height: 1080 };
    // 16:9 source in a 16:9 frame at half size: 960x540 centered.
    expect(layerRect({ width: 1280, height: 720 }, project, project, placementOf({ scale: 0.5 }))).toEqual({ left: 480, top: 270, width: 960, height: 540 });
    // Square logo, pillarboxed to 1080x1080, a quarter of that, 600 px right and 300 px up of center.
    expect(layerRect({ width: 500, height: 500 }, project, project, placementOf({ scale: 0.25, x: 600, y: -300 }))).toEqual({
      left: 1425,
      top: 105,
      width: 270,
      height: 270,
    });
  });

  it("maps project-pixel offsets onto a smaller output (preview canvas, preset)", () => {
    const rect = layerRect({ width: 500, height: 500 }, { width: 960, height: 540 }, { width: 1920, height: 1080 }, placementOf({ scale: 0.25, x: 600, y: -300 }));
    expect(rect).toEqual({ left: 713, top: 53, width: 135, height: 135 });
  });

  it("composes a nested timeline's placement with its clips'", () => {
    expect(composePlacement(placementOf({ x: 100, scale: 0.5, opacity: 0.5 }), placementOf({ x: 200, y: 40, scale: 0.5, opacity: 0.8 }))).toEqual({
      x: 200,
      y: 20,
      scale: 0.25,
      opacity: 0.4,
    });
  });
});

const timeline = (id: string, tracks: Timeline["tracks"]): Timeline => ({ schemaVersion: 1, id, revision: 0, tracks });

describe("flattenTimeline", () => {
  // Nested intro: 4 s of camera on its V1, a title on its V2 from 1 s to 3 s, music on its A1.
  const intro = timeline("intro", [
    {
      id: "v1",
      kind: "video",
      clips: [{ id: "c_cam", type: "media", asset: "assets/cam.mp4", start: 0, in: 10, out: 14 }],
    },
    {
      id: "v2",
      kind: "video",
      clips: [{ id: "c_title", type: "media", asset: "assets/title.png", start: 1, in: 0, out: 2, transform: { x: 100, scale: 0.5 } }],
    },
    { id: "a1", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 4, audio: { gain: -6 } }] },
  ]);
  const resolve = (source: string) => (source === "timelines/intro.json" ? intro : null);

  it("replaces a nested clip with the nested tracks' clips inside its window, shifted to its start", () => {
    const main = timeline("main", [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "c_a", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5 },
          // Plays intro seconds 2 to 4 at 5 s, half size, 6 dB quieter.
          { id: "c_nest", type: "timeline", source: "timelines/intro.json", start: 5, in: 2, transform: { scale: 0.5 }, audio: { gain: -6 } },
        ],
      },
    ]);
    const flat = flattenTimeline(main, resolve);
    expect(flat.tracks.map((track) => [track.id, track.kind])).toEqual([
      ["v1", "video"],
      ["v1/2", "video"],
      ["v1/a1", "audio"],
    ]);
    const [v1, v2, a1] = flat.tracks as Extract<Timeline["tracks"][number], { clips: unknown }>[];
    expect(v1!.clips).toEqual([
      { id: "c_a", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5 },
      // Camera source 12 to 14 (intro seconds 2 to 4) at 5 s.
      { id: "c_nest/c_cam", type: "media", asset: "assets/cam.mp4", start: 5, in: 12, out: 14, transform: { x: 0, y: 0, scale: 0.5, opacity: 1 }, audio: { gain: -6 } },
    ]);
    // Title's last second (intro 2 to 3), its placement inside the half-size nested frame.
    expect(v2!.clips).toEqual([
      { id: "c_nest/c_title", type: "media", asset: "assets/title.png", start: 5, in: 1, out: 2, transform: { x: 50, y: 0, scale: 0.25, opacity: 1 }, audio: { gain: -6 } },
    ]);
    expect(a1!.clips).toEqual([{ id: "c_nest/c_music", type: "media", asset: "assets/music.wav", start: 5, in: 2, out: 4, audio: { gain: -12 } }]);
  });

  it("honours an explicit duration and keeps sped-up media in step", () => {
    const fast = timeline("fast", [
      { id: "v1", kind: "video", clips: [{ id: "c_f", type: "media", asset: "assets/f.mp4", start: 0, in: 0, out: 8, speed: 2 }] },
    ]);
    const main = timeline("main", [
      { id: "v1", kind: "video", clips: [{ id: "c_n", type: "timeline", source: "timelines/fast.json", start: 1, in: 1, duration: 2 }] },
    ]);
    const flat = flattenTimeline(main, (source) => (source === "timelines/fast.json" ? fast : null));
    // Fast seconds 1 to 3 read source 2 to 6 at 2x.
    expect((flat.tracks[0] as { clips: unknown[] }).clips).toEqual([
      { id: "c_n/c_f", type: "media", asset: "assets/f.mp4", start: 1, in: 2, out: 6, speed: 2 },
    ]);
  });

  it("keeps a nested clip it cannot resolve (missing file, cycle) for the caller to report", () => {
    const loop = timeline("loop", [
      { id: "v1", kind: "video", clips: [{ id: "c_self", type: "timeline", source: "timelines/loop.json", start: 0, duration: 1 }] },
    ]);
    const missing = timeline("main", [
      { id: "v1", kind: "video", clips: [{ id: "c_gone", type: "timeline", source: "timelines/gone.json", start: 0, duration: 1 }] },
    ]);
    expect(flattenTimeline(missing, () => null)).toEqual(missing);
    // The root is `timelines/<id>.json`: a clip nesting it again would never end.
    expect(flattenTimeline(loop, (source) => (source === "timelines/loop.json" ? loop : null))).toEqual(loop);
  });
});
