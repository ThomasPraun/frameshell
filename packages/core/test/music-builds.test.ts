import { describe, expect, it } from "vitest";
import { type AudioEffect, isBuild } from "@frameshell/schema";
import { planBuildEffects } from "../src/music/builds.js";

const build = { seconds: 2, startHz: 40, endHz: 300 };

describe("planBuildEffects", () => {
  it("caps a window at the longest sweep of the schema: a clip at speed 2 asked for 20 s starts 30 s before the hit", () => {
    const warnings: string[] = [];
    const clip = { id: "c_music", start: 0, in: 0, out: 100, speed: 2 };
    const { sweeps, effects } = planBuildEffects(clip, [30], { ...build, seconds: 20 }, warnings);
    expect(sweeps).toEqual([{ at: 30, from: 30, to: 60, startHz: 40, endHz: 300 }]);
    expect(effects).toEqual([{ kind: "highpassSweep", from: 30, to: 60, startHz: 40, endHz: 300, auto: "music" }]);
    expect(warnings).toEqual([]);
  });

  it("writes a build of exactly the shortest window although the rounded ends differ by 0.0999999", () => {
    const warnings: string[] = [];
    const clip = { id: "c_music", start: 0, in: 5.2, out: 20 };
    const { sweeps } = planBuildEffects(clip, [0.1], { ...build, seconds: 0.1 }, warnings);
    expect(sweeps).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("recognizes only marked sweeps as builds", () => {
    const marked: AudioEffect = { kind: "highpassSweep", from: 1, to: 2, auto: "music" };
    expect(isBuild(marked)).toBe(true);
    expect(isBuild({ ...marked, auto: undefined })).toBe(false);
  });
});
