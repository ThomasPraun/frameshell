import { describe, expect, it } from "vitest";
import { parseLoudness } from "../src/analyze/loudness.js";
import { PaletteBuilder } from "../src/analyze/palette.js";
import { analysisName } from "../src/analyze/service.js";
import { MIN_CUT_GAP_FRAMES, detectCuts, frameAt, frameStart, parseSceneScores, shotMiddle, shotStats, shotsOf } from "../src/analyze/shots.js";

// The pure parts of `analyze` (#471): cuts, shots, palette, loudness text, names.

describe("frameStart and frameAt", () => {
  it("write a frame's time as frame / fps rounded down to the millisecond", () => {
    expect(frameStart(1, 30)).toBe(0.033);
    expect(frameStart(7, 24)).toBe(0.291);
    expect(frameStart(30, 30)).toBe(1);
    // 1001 / 30000 x 1000 is 33.3667 ms: down, not to the nearest.
    expect(frameStart(1, 30000 / 1001)).toBe(0.033);
    expect(frameStart(2, 30000 / 1001)).toBe(0.066);
  });

  it("frameAt is the frame showing at a time, and agrees with frameStart", () => {
    for (const fps of [24, 25, 29.97, 30, 60]) {
      for (const frame of [0, 1, 7, 100, 1234]) {
        // The written start of a frame lies a rounding error before it at most: it still belongs to the frame or the one before.
        expect(frameAt(frame / fps, fps)).toBe(frame);
        expect([frame, frame - 1]).toContain(frameAt(frameStart(frame, fps), fps));
      }
    }
  });
});

describe("detectCuts", () => {
  const scores = (pairs: [number, number][]) => pairs.map(([frame, score]) => ({ frame, score }));

  it("takes frames from the second on at or above the threshold", () => {
    const cuts = detectCuts(scores([[0, 0.9], [1, 0.1], [10, 0.3], [20, 0.29], [30, 0.8]]));
    expect(cuts).toEqual([{ frame: 10, score: 0.3 }, { frame: 30, score: 0.8 }]);
  });

  it("counts a run of candidates close together once, as the strongest", () => {
    expect(MIN_CUT_GAP_FRAMES).toBe(3);
    const cuts = detectCuts(scores([[10, 0.4], [11, 0.9], [12, 0.5], [40, 0.5], [50, 0.6], [53, 0.7]]));
    // 50 and 53 are 3 frames apart: two cuts. 10 to 12 are one.
    expect(cuts).toEqual([{ frame: 11, score: 0.9 }, { frame: 40, score: 0.5 }, { frame: 50, score: 0.6 }, { frame: 53, score: 0.7 }]);
  });

  it("follows a lower or higher threshold", () => {
    const s = scores([[5, 0.1], [15, 0.2], [25, 0.5]]);
    expect(detectCuts(s, 0.05).map((cut) => cut.frame)).toEqual([5, 15, 25]);
    expect(detectCuts(s, 0.4).map((cut) => cut.frame)).toEqual([25]);
  });
});

describe("shots", () => {
  it("shotsOf splits a film at its cuts and numbers the shots from 1", () => {
    const shots = shotsOf([{ frame: 30, score: 0.5 }, { frame: 75, score: 0.7 }], 100);
    expect(shots).toEqual([
      { index: 1, startFrame: 0, endFrame: 30, cutScore: null },
      { index: 2, startFrame: 30, endFrame: 75, cutScore: 0.5 },
      { index: 3, startFrame: 75, endFrame: 100, cutScore: 0.7 },
    ]);
  });

  it("shotsOf ignores cuts outside the film and holds one shot without cuts", () => {
    expect(shotsOf([{ frame: 0, score: 1 }, { frame: 100, score: 1 }], 100)).toEqual([{ index: 1, startFrame: 0, endFrame: 100, cutScore: null }]);
  });

  it("shotMiddle is a frame inside the shot, even of one frame", () => {
    expect(shotMiddle({ startFrame: 30, endFrame: 75 })).toBe(52);
    expect(shotMiddle({ startFrame: 7, endFrame: 8 })).toBe(7);
    expect(shotMiddle({ startFrame: 7, endFrame: 9 })).toBe(7);
  });

  it("shotStats gives the count, the cuts per minute and the lengths", () => {
    // 30 fps, 10 s in all: shots of 2, 3 and 5 s.
    const shots = [{ startFrame: 0, endFrame: 60 }, { startFrame: 60, endFrame: 150 }, { startFrame: 150, endFrame: 300 }];
    expect(shotStats(shots, 30)).toEqual({ shotCount: 3, cutsPerMinute: 12, averageLength: 3.333, medianLength: 3, shortest: 2, longest: 5 });
  });

  it("shotStats takes the middle of two lengths for an even count of shots", () => {
    expect(shotStats([{ startFrame: 0, endFrame: 30 }, { startFrame: 30, endFrame: 90 }], 30).medianLength).toBe(1.5);
    expect(shotStats([{ startFrame: 0, endFrame: 30 }], 30)).toMatchObject({ shotCount: 1, cutsPerMinute: 0 });
  });
});

describe("parseSceneScores", () => {
  it("reads frame and score from ffmpeg's metadata print, the frame from the time", () => {
    const text = [
      "frame:0    pts:0       pts_time:0",
      "lavfi.scene_score=0.000000",
      "frame:1    pts:1024    pts_time:0.0333333",
      "lavfi.scene_score=0.012000",
      "frame:2    pts:2048    pts_time:0.0666667",
      "lavfi.scene_score=0.610000",
      "",
    ].join("\n");
    expect(parseSceneScores(text, 30)).toEqual([{ frame: 0, score: 0 }, { frame: 1, score: 0.012 }, { frame: 2, score: 0.61 }]);
  });

  it("skips lines it does not know", () => {
    expect(parseSceneScores("garbage\nlavfi.scene_score=0.5\nframe:3 pts:1 pts_time:0.1\nlavfi.scene_score=0.4\n", 30)).toEqual([{ frame: 3, score: 0.4 }]);
  });
});

describe("PaletteBuilder", () => {
  const solid = (r: number, g: number, b: number, pixels: number) => Uint8Array.from({ length: pixels * 3 }, (_, i) => [r, g, b][i % 3]!);

  it("reports the dominant colours with their share, biggest first", () => {
    const palette = new PaletteBuilder();
    palette.add(solid(255, 0, 0, 60));
    palette.add(solid(0, 0, 255, 30));
    palette.add(solid(10, 10, 10, 10));
    expect(palette.colors()).toEqual([
      { hex: "#ff0000", share: 0.6 },
      { hex: "#0000ff", share: 0.3 },
      { hex: "#0a0a0a", share: 0.1 },
    ]);
  });

  it("merges close shades into one colour at their mean", () => {
    const palette = new PaletteBuilder();
    palette.add(solid(200, 100, 50, 50));
    palette.add(solid(206, 104, 54, 50));
    const colors = palette.colors();
    expect(colors).toHaveLength(1);
    expect(colors[0]).toEqual({ hex: "#cb6634", share: 1 });
  });

  it("leaves out a colour under 1 % and gives none without pixels", () => {
    const palette = new PaletteBuilder();
    palette.add(solid(0, 255, 0, 995));
    palette.add(solid(255, 0, 255, 5));
    expect(palette.colors().map((color) => color.hex)).toEqual(["#00ff00"]);
    expect(new PaletteBuilder().colors()).toEqual([]);
  });

  it("merge counts what the other counted", () => {
    const a = new PaletteBuilder();
    const b = new PaletteBuilder();
    a.add(solid(255, 0, 0, 10));
    b.add(solid(0, 0, 255, 30));
    a.merge(b);
    expect(a.pixels).toBe(40);
    expect(a.colors()).toEqual([{ hex: "#0000ff", share: 0.75 }, { hex: "#ff0000", share: 0.25 }]);
  });

  it("is deterministic and keeps at most five colours", () => {
    const palette = new PaletteBuilder();
    for (let i = 0; i < 8; i++) palette.add(solid(i * 32, 255 - i * 32, (i * 90) % 256, 10 + i));
    const first = palette.colors();
    expect(first.length).toBeLessThanOrEqual(5);
    expect(palette.colors()).toEqual(first);
    expect(first.map((color) => color.share)).toEqual([...first.map((color) => color.share)].sort((x, y) => y - x));
  });
});

describe("parseLoudness", () => {
  const block = (i: number, lra: number, peak: number) => `frame:3  pts:1 pts_time:3.2\nlavfi.r128.M=-20\nlavfi.r128.S=-20\nlavfi.r128.I=${i}\nlavfi.r128.LRA=${lra}\nlavfi.r128.true_peak=${peak}\n`;

  it("takes the last block: the figures over the whole sound", () => {
    expect(parseLoudness(block(-30, 0, 0.01) + block(-21.774, 4.26, 0.131))).toEqual({ integrated: -21.8, range: 4.3, truePeak: -17.7 });
  });

  it("reads silence as null, and nothing as no reading", () => {
    expect(parseLoudness(block(-70, 0, 0))).toEqual({ integrated: null, range: null, truePeak: null });
    expect(parseLoudness("lavfi.r128.I=-inf\nlavfi.r128.LRA=0\nlavfi.r128.true_peak=0")).toEqual({ integrated: null, range: null, truePeak: null });
    expect(parseLoudness("")).toBeNull();
  });
});

describe("analysisName", () => {
  it("is the file name without extension, lower case, in characters a folder keeps", () => {
    expect(analysisName("/refs/Reel Final (v2).MP4")).toBe("reel-final-v2");
    expect(analysisName("/refs/clip.name.mov")).toBe("clip.name");
    expect(analysisName("/refs/___.mp4")).toBe("video");
    expect(analysisName(`/refs/${"a".repeat(100)}.mp4`)).toHaveLength(64);
  });
});
