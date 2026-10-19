import { join } from "node:path";
import type { MulticamGroup } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { MotionStore, frameDifference, groupMotion, motionStretches, pictureDifferences } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run } from "./media-tools.js";

describe("motionStretches", () => {
  it("turns samples above the threshold into stretches on the file's clock", () => {
    // 4 samples a second: sample i compares the frames at i/4 and (i+1)/4.
    const differences = [0, 0, 2, 3, 0, 0, 0, 5, 0];
    expect(motionStretches(differences, 0.3)).toEqual([
      { start: 0.5, end: 1 },
      { start: 1.75, end: 2 },
    ]);
  });

  it("closes a stretch that runs to the end and finds none in a still picture", () => {
    expect(motionStretches([0, 1, 1], 0.3)).toEqual([{ start: 0.25, end: 0.75 }]);
    expect(motionStretches([0.1, 0.2, 0.1], 0.3)).toEqual([]);
    expect(motionStretches([], 0.3)).toEqual([]);
  });

  it("measures the mean brightness change of two frames", () => {
    expect(frameDifference(Uint8Array.of(0, 0, 0, 0), Uint8Array.of(0, 4, 0, 8))).toBe(3);
  });
});

describe("groupMotion", () => {
  const group: MulticamGroup = {
    id: "g_talk",
    angles: [
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
      { id: "slides", name: "Slides", asset: "assets/slides.mp4", offset: 1.5, screen: true },
      { id: "demo", name: "Demo", asset: "assets/demo.mp4", offset: 0, screen: true },
    ],
  };

  it("measures screen angles only, on the group clock, sorted, and warns about one it cannot read", async () => {
    const asked: string[] = [];
    const source = {
      differences: async (_root: string, asset: string) => {
        asked.push(asset);
        if (asset === "assets/demo.mp4") throw new Error("broken file");
        return Float32Array.of(0, 5, 5, 0);
      },
    };
    const result = await groupMotion(source, "/project", group, 0.3);
    expect(asked).toEqual(["assets/slides.mp4", "assets/demo.mp4"]);
    expect(result.motion).toEqual([{ angle: "slides", start: 1.75, end: 2.25 }]);
    expect(result.warnings).toEqual(["Demo (assets/demo.mp4): could not read the picture (broken file), so it has no motion."]);
  });
});

describe("pictureDifferences", () => {
  it(
    "finds the motion of a real file: still for 2 s, then moving, and keeps it in memory",
    async () => {
      const { ffmpeg } = await mediaTools();
      const root = tempDir();
      const file = join(root, "screen.mp4");
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=10:d=2"],
        ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=2"],
        ...["-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0"],
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p", file],
      ]);
      const differences = await pictureDifferences(ffmpeg, file);
      expect(differences.length).toBeGreaterThanOrEqual(14);
      const [stretch, ...rest] = motionStretches(differences, 0.3);
      expect(rest).toEqual([]);
      expect(stretch!.start).toBeGreaterThanOrEqual(1.5);
      expect(stretch!.start).toBeLessThanOrEqual(2);
      expect(stretch!.end).toBeGreaterThanOrEqual(3.5);

      let probes = 0;
      const store = new MotionStore({
        ffmpeg: async () => {
          probes++;
          return ffmpeg;
        },
      });
      const first = await store.differences(root, "screen.mp4");
      expect(Array.from(first)).toEqual(Array.from(differences));
      await store.differences(root, "screen.mp4");
      expect(probes).toBe(1);
    },
    120_000,
  );
});
