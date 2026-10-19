import type { MulticamGroup, ShotClip, Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, type ExportSource, compileRender } from "../src/index.js";

// Screen and pip shots in the export plan (ADR 0016): the screen whole, the inset over it.
const group: MulticamGroup = {
  id: "g_talk",
  angles: [
    { id: "slides", name: "Slides", asset: "assets/slides.mp4", offset: 0, screen: true },
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
  ],
};
const shots: ShotClip[] = [
  { id: "c_1", type: "shot", start: 0, in: 0, out: 1, shot: "screen", angles: ["slides"] },
  { id: "c_2", type: "shot", start: 1, in: 1, out: 2, shot: "pip", angles: ["slides", "ana"], corner: "top-left" },
];
const timeline: Timeline = { schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: shots }], groups: [group] };
const video = (width: number, height: number): ExportSource => ({ path: "/project/x.mp4", video: { codec: "h264", still: false, width, height }, audio: true });
// A 4:3 screen in a 16:9 frame gets bars; Ana's 16:9 picture is the inset.
const sources = new Map<string, ExportSource>([
  ["assets/slides.mp4", video(1600, 1200)],
  ["assets/ana.mp4", video(1920, 1080)],
]);
const preset = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;

describe("screen and pip in the export plan", () => {
  const plan = compileRender({ timeline, fps: 30, preset, loudness: -17, sources, resolution: { width: 1920, height: 1080 }, segmentSeconds: 1 });
  const [screenShot, pipShot] = [plan.files["seg-0001.filter"]!, plan.files["seg-0002.filter"]!];

  it("fits a screen shot whole, centred, with bars", () => {
    // 1600x1200 fitted into 1920x1080 is 1440x1080 at x=240; nothing of the picture is cut.
    expect(screenShot).toContain("crop=1600:1200:0:0,scale=1440:1080");
      });

  it("puts the inset over the screen, in the chosen corner", () => {
    expect(pipShot).toContain("crop=1600:1200:0:0,scale=1440:1080");
    // Ana's 16:9 inset: a quarter of the width, 2% margin, top-left.
    expect(pipShot).toContain("scale=480:270");
    expect(pipShot).toContain("overlay=x=38:y=38");
    expect(pipShot.indexOf("overlay=x=0:y=0")).toBeLessThan(pipShot.indexOf("overlay=x=38:y=38"));
  });

  it("blacks the bars of a screen shot so a lower track does not show through", () => {
    expect(screenShot).toContain("pad=1920:1080:240:0:black");
    expect(screenShot).toContain("overlay=x=0:y=0");
    expect(pipShot).toContain("pad=1920:1080:240:0:black");
    expect(plan.files["seg-0001.filter"]).not.toContain("overlay=x=240");
  });

  it("does not pad a screen that fills the frame", () => {
    const wide = new Map(sources).set("assets/slides.mp4", video(1920, 1080));
    const flat = compileRender({ timeline, fps: 30, preset, loudness: -17, sources: wide, resolution: { width: 1920, height: 1080 }, segmentSeconds: 1 });
    expect(flat.files["seg-0001.filter"]).not.toContain("pad=");
  });

  it("paints the opaque bars over a video track under the program track", () => {
    const under = {
      id: "t_v1",
      kind: "video" as const,
      clips: [{ id: "c_b", type: "media" as const, asset: "assets/broll.mp4", start: 0, in: 0, out: 2 }],
    };
    const withBroll = new Map(sources).set("assets/broll.mp4", video(1920, 1080));
    const layered = compileRender({
      timeline: { ...timeline, tracks: [under, ...timeline.tracks] },
      fps: 30,
      preset,
      loudness: -17,
      sources: withBroll,
      resolution: { width: 1920, height: 1080 },
      segmentSeconds: 1,
    });
    const filter = layered.files["seg-0001.filter"]!;
    // b-roll first, then the screen padded to the whole frame: nothing of b-roll survives the bars.
    expect(filter.indexOf("scale=1920:1080")).toBeLessThan(filter.indexOf("pad=1920:1080:240:0:black"));
    expect(filter).toContain("overlay=x=0:y=0");
  });
});
