import { describe, expect, it } from "vitest";
import {
  DIRECTOR_TEMPLATES,
  type MulticamGroup,
  type ShotClip,
  createTimeline,
  parseDirectorFile,
  parseTimeline,
  resolveDirectorRules,
  shotLayers,
  shotTiles,
} from "../src/index.js";

// Screen and picture-in-picture shots (ADR 0016).
const group: MulticamGroup = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0, crop: { left: 0.25 } },
    { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0, crop: { left: 0.25, right: 0.25 } },
  ],
};

const landscape = { width: 1920, height: 1080 };
const portrait = { width: 1080, height: 1920 };
const sizes = (asset: string) => (asset === "assets/eva.mp4" ? { width: 1280, height: 720 } : { width: 1920, height: 1080 });

const shot = (layout: ShotClip["shot"], angles: string[], extra: Partial<ShotClip> = {}): ShotClip => ({
  id: "c_1",
  type: "shot",
  start: 0,
  in: 0,
  out: 1,
  shot: layout,
  angles,
  ...extra,
});

const errorOf = (clips: ShotClip[], groups: MulticamGroup[] = [group]) => {
  const result = parseTimeline({ ...createTimeline("main"), groups, tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips }] });
  return result.ok ? null : result.error;
};

describe("screen shot layout", () => {
  it("shows the whole picture centred, with bars where its shape differs", () => {
    expect(shotLayers(shot("screen", ["ana"]), group, landscape, sizes)).toEqual([
      { angle: "ana", asset: "assets/ana.mp4", tile: { left: 0, top: 0, width: 1920, height: 1080 }, crop: { left: 0, top: 0, width: 1920, height: 1080 } },
    ]);
    // Eva keeps 640x720 of 1280x720: fitted to the height, never cut to 16:9.
    expect(shotLayers(shot("screen", ["eva"]), group, landscape, sizes)).toEqual([
      { angle: "eva", asset: "assets/eva.mp4", tile: { left: 480, top: 0, width: 960, height: 1080 }, crop: { left: 320, top: 0, width: 640, height: 720 } },
    ]);
    expect(shotLayers(shot("screen", ["ana"]), group, portrait, sizes)[0]).toMatchObject({
      tile: { left: 0, top: 656, width: 1080, height: 608 },
      crop: { left: 0, top: 0, width: 1920, height: 1080 },
    });
  });
});

describe("pip shot layout", () => {
  it("puts the inset in its picture's aspect, bottom-right by default, over the whole screen", () => {
    const [screen, inset] = shotLayers(shot("pip", ["ana", "ben"]), group, landscape, sizes);
    expect(screen).toMatchObject({ angle: "ana", tile: { left: 0, top: 0, width: 1920, height: 1080 } });
    // Ben's cropped picture is 1440x1080 (4:3): a quarter of the width, 2% margin.
    expect(inset).toEqual({
      angle: "ben",
      asset: "assets/ben.mp4",
      tile: { left: 1402, top: 682, width: 480, height: 360 },
      crop: { left: 480, top: 0, width: 1440, height: 1080 },
    });
  });

  it("honours every corner", () => {
    const tile = (corner: NonNullable<ShotClip["corner"]>) => shotLayers(shot("pip", ["ana", "ben"], { corner }), group, landscape, sizes)[1]!.tile;
    expect(tile("top-left")).toEqual({ left: 38, top: 38, width: 480, height: 360 });
    expect(tile("top-right")).toEqual({ left: 1402, top: 38, width: 480, height: 360 });
    expect(tile("bottom-left")).toEqual({ left: 38, top: 682, width: 480, height: 360 });
    expect(tile("bottom-right")).toEqual({ left: 1402, top: 682, width: 480, height: 360 });
  });

  it("keeps a tall inset within 40% of the frame height", () => {
    const tall: MulticamGroup = { ...group, angles: group.angles.map((angle) => (angle.id === "ben" ? { ...angle, crop: { left: 0.4, right: 0.4 } } : angle)) };
    expect(shotLayers(shot("pip", ["ana", "ben"]), tall, landscape, sizes)[1]!.tile).toMatchObject({ width: 154, height: 432 });
  });

  it("scales to a vertical frame", () => {
    expect(shotTiles("pip", 2, portrait, 4 / 3)[1]).toEqual({ left: 788, top: 1695, width: 270, height: 203 });
    const [screen] = shotLayers(shot("pip", ["ana", "ben"]), group, portrait, sizes);
    expect(screen!.tile).toEqual({ left: 0, top: 656, width: 1080, height: 608 });
  });
});

describe("screen and pip in the timeline model", () => {
  it("accepts both layouts, the corner on pip and the screen flag on an angle", () => {
    const marked: MulticamGroup = { ...group, angles: group.angles.map((angle) => (angle.id === "ana" ? { ...angle, screen: true } : angle)) };
    const clips = [shot("screen", ["ana"]), { ...shot("pip", ["ana", "ben"], { corner: "top-left" }), id: "c_2", start: 1, in: 1, out: 2 }];
    expect(errorOf(clips, [marked])).toBeNull();
  });

  it("refuses a corner on any other layout and a wrong angle count", () => {
    expect(errorOf([shot("solo", ["ana"], { corner: "top-left" })])).toBe("tracks.0.clips.0.corner: only a pip shot has a corner");
    expect(errorOf([shot("pip", ["ana"])])).toBe("tracks.0.clips.0.angles: a pip shot takes exactly 2 angle(s), got 1");
    expect(errorOf([shot("screen", ["ana", "ben"])])).toBe("tracks.0.clips.0.angles: a screen shot takes exactly 1 angle(s), got 2");
  });
});

describe("director screen rules", () => {
  it("every template has them and a file overrides field by field", () => {
    for (const template of Object.values(DIRECTOR_TEMPLATES)) expect(template.screen).toMatchObject({ pip: true, corner: "bottom-right" });
    const file = parseDirectorFile({ template: "podcast-calm", screen: { motion: null, corner: "top-right" } });
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(resolveDirectorRules(file.value).rules.screen).toEqual({ ...DIRECTOR_TEMPLATES["podcast-calm"].screen, motion: null, corner: "top-right" });
  });

  it("rejects unknown screen keys and a bad corner", () => {
    expect(parseDirectorFile({ screen: { motoin: 3 } }).ok).toBe(false);
    expect(parseDirectorFile({ screen: { corner: "middle" } }).ok).toBe(false);
  });
});
