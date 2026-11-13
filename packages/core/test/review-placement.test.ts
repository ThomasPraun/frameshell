import { join } from "node:path";
import type { Timeline } from "@frameshell/schema";
import { SAFE_ZONES } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import type { GeneratedSource } from "../src/export/compiler.js";
import type { ScannedAsset } from "../src/people/face-clusters.js";
import { alphaBox, faceBoxes, graphicBoxes } from "../src/review/placement.js";
import { boxCrossings, filmInsets, safeFlags, safeWarnings, subjectsAt } from "../src/review/safe.js";
import { mediaTools, run } from "./media-tools.js";
import { tempDir } from "./helpers.js";

// Graphics and faces against a platform's safe zones (#457): boxes in the film's pixels, then crossings.

const film = { width: 1080, height: 1920 };
const insets = filmInsets(SAFE_ZONES["instagram-reels"], film);

/** A timeline with the given video tracks; only what the placement reads is filled in. */
function timeline(...tracks: object[]): Timeline {
  return { id: "main", tracks } as unknown as Timeline;
}

/** A face scan of a 1920x1080 video: one track with the given detections `[time, x, y, width, height]` (fractions, centre). */
function scanned(asset: string, ...boxes: [number, number, number, number, number][]): ScannedAsset {
  return {
    asset,
    scan: {
      hash: "sha256:x",
      models: { detector: "d", recognizer: "r" },
      hz: 2,
      width: 1920,
      height: 1080,
      samples: boxes.length,
      tracks: [{ id: "t1", start: boxes[0]![0], end: boxes.at(-1)![0], boxes: boxes.map(([time, x, y, width, height]) => ({ time, x, y, width, height, score: 0.9 })), embeddings: [] }],
    },
  };
}

describe("review placement: faces", () => {
  it("places a detection in the film through the clip's layer: fitted, then moved by the transform", () => {
    // A landscape clip fits the vertical film 1080 x 608, centred; lowered by 700 px its face sits in the bottom zone.
    const clip = { id: "c1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 10, transform: { y: 700 } };
    const found = faceBoxes(timeline({ id: "v1", kind: "video", clips: [clip] }), [scanned("assets/a.mp4", [1, 0.5, 0.5, 0.1, 0.2])], film, film);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subject: "face", track: "v1", clip: "c1", from: 1, to: 1.5 });
    expect(found[0]!.box.x0).toBeCloseTo(486, 0);
    expect(found[0]!.box.x1).toBeCloseTo(594, 0);
    expect(found[0]!.box.y0).toBeCloseTo(1599.2, 0);
    const crossing = boxCrossings(found, insets, film, 30);
    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toMatchObject({ subject: "face", clip: "c1", start: 30, end: 45 });
    expect(crossing[0]!.zones.map((zone) => zone.edge)).toEqual(["bottom"]);
  });

  it("maps source time to timeline time with the clip's start, in point and speed, and leaves out detections the clip does not play", () => {
    const clip = { id: "c1", type: "media", asset: "assets/a.mp4", start: 5, in: 2, out: 6, speed: 2 };
    const scan = scanned("assets/a.mp4", [1, 0.5, 0.5, 0.1, 0.1], [4, 0.5, 0.5, 0.1, 0.1], [6, 0.5, 0.5, 0.1, 0.1]);
    const found = faceBoxes(timeline({ id: "v1", kind: "video", clips: [clip] }), [scan], film, film);
    // Source 4 s is (4 - 2) / 2 = 1 s into the clip; 1 s and 6 s lie outside [2, 6).
    expect(found.map((face) => [face.from, face.to])).toEqual([[6, 6.25]]);
  });

  it("skips hidden tracks, other kinds of clip and assets with no scan", () => {
    const clip = { id: "c1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 10 };
    const scan = scanned("assets/a.mp4", [1, 0.5, 0.5, 0.1, 0.1]);
    expect(faceBoxes(timeline({ id: "v1", kind: "video", hidden: true, clips: [clip] }), [scan], film, film)).toEqual([]);
    expect(faceBoxes(timeline({ id: "v1", kind: "video", clips: [{ ...clip, asset: "assets/b.mp4" }] }), [scan], film, film)).toEqual([]);
    expect(faceBoxes(timeline({ id: "a1", kind: "audio", clips: [clip] }), [scan], film, film)).toEqual([]);
  });

  it("a face is a flag with the clip, the zone and how far it reaches in, and a craft warning that names them", () => {
    const clip = { id: "c1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 10, transform: { y: 700 } };
    const found = faceBoxes(timeline({ id: "v1", kind: "video", clips: [clip] }), [scanned("assets/a.mp4", [1, 0.5, 0.5, 0.1, 0.2], [2, 0.5, 0.5, 0.1, 0.2])], film, film);
    const crossing = boxCrossings(found, insets, film, 30);
    const flags = safeFlags(crossing, 30);
    expect(flags).toEqual([{ subject: "face", track: "v1", clip: "c1", zone: "bottom", cues: 2, first: 1, last: 2, reach: expect.any(Number) }]);
    expect(subjectsAt(crossing, 31)).toEqual(["face"]);
    expect(subjectsAt(crossing, 10)).toEqual([]);
    const warnings = safeWarnings("instagram-reels", flags);
    expect(warnings).toEqual([{ check: "safe-zone", from: 1, to: 2, message: expect.stringContaining("a face of clip c1 reaches") }]);
    // A caption's flag is not repeated as a craft warning.
    expect(safeWarnings("tiktok", [{ subject: "subtitle", track: "s1", zone: "bottom", cues: 1, first: 0, last: 0, reach: 5 }])).toEqual([]);
  });
});

describe("review placement: graphics", () => {
  it("the box of an alpha picture is the extent of the pixels at or above the threshold, as fractions", () => {
    const grey = new Uint8Array(10 * 10);
    for (let y = 2; y < 5; y++) for (let x = 1; x < 7; x++) grey[y * 10 + x] = 255;
    grey[9 * 10 + 9] = 10;
    expect(alphaBox(grey, 10, 10)).toEqual({ x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.5 });
    expect(alphaBox(new Uint8Array(100), 10, 10)).toBeNull();
  });

  it("measures a generated clip's alpha from a real render and places it through the clip's layer", async () => {
    const { ffmpeg } = await mediaTools();
    const dir = tempDir();
    const render = join(dir, "title.webm");
    // A 320x180 transparent frame with a white box over x 40-280, y 130-170: low in the frame, and wide.
    await run(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", "color=c=black@0.0:s=320x180:r=10:d=2,format=yuva420p"],
      ...["-f", "lavfi", "-i", "color=c=white:s=240x40:r=10:d=2,format=yuva420p"],
      ...["-filter_complex", "[0][1]overlay=40:130:format=auto,format=yuva420p"],
      ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", render],
    ]);
    const source: GeneratedSource = { path: render, hasAlpha: true, width: 320, height: 180 };
    const clip = { id: "title1", type: "hyperframes", start: 3, duration: 2 };
    const found = await graphicBoxes({
      ffmpeg,
      timeline: timeline({ id: "v2", kind: "video", clips: [clip] }),
      renders: new Map([["title1", source]]),
      film: { width: 1920, height: 1080 },
      project: { width: 1920, height: 1080 },
      work: join(dir, "work"),
    });
    expect(found.opaque).toEqual([]);
    expect(found.boxes.length).toBeGreaterThan(1);
    const first = found.boxes[0]!;
    expect(first).toMatchObject({ subject: "graphic", track: "v2", clip: "title1", from: 3 });
    expect(first.to).toBeCloseTo(3.25, 2);
    // The whole 1920x1080 frame holds the render: 40/320 x 1920 = 240, 130/180 x 1080 = 780, to 1680 and 1020.
    expect(first.box.x0).toBeGreaterThan(200);
    expect(first.box.x0).toBeLessThan(280);
    expect(first.box.x1).toBeGreaterThan(1640);
    expect(first.box.y0).toBeGreaterThan(740);
    expect(first.box.y0).toBeLessThan(820);
    expect(found.boxes.at(-1)!.to).toBeLessThanOrEqual(5);
    // The box ends at 1020 px of 1080: inside youtube's 54 px bottom edge it would reach, 60 px up it does not.
    const crossing = boxCrossings(found.boxes, filmInsets(SAFE_ZONES.youtube, { width: 1920, height: 1080 }), { width: 1920, height: 1080 }, 30);
    expect(crossing).toEqual([]);
  }, 120_000);

  it("a render with no alpha fills its frame: the clip is listed, not measured", async () => {
    const { ffmpeg } = await mediaTools();
    const found = await graphicBoxes({
      ffmpeg,
      timeline: timeline({ id: "v1", kind: "video", clips: [{ id: "bg", type: "hyperframes", start: 0, duration: 2 }] }),
      renders: new Map([["bg", { path: "/none.mp4", hasAlpha: false, width: 320, height: 180 }]]),
      film: { width: 1920, height: 1080 },
      project: { width: 1920, height: 1080 },
      work: tempDir(),
    });
    expect(found).toEqual({ boxes: [], opaque: ["bg"] });
  });
});
