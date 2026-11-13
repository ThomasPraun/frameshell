import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { classifyLoudness, loudnessCacheKey } from "../src/media/loudness-store.js";
import { candidateTarget, gainFor, peakWarning, voiceLoudness, voiceParts } from "../src/media/loudness-plan.js";

describe("gains from loudness", () => {
  it("brings a file to a target in 0.1 dB steps", () => {
    expect(gainFor(-20, -18)).toBe(2);
    expect(gainFor(-14.04, -23)).toBe(-9);
    expect(gainFor(-23, -23)).toBe(0);
  });

  it("takes the quietest file as the target unless one is given, so nothing is raised", () => {
    expect(candidateTarget([-14, -20, -17], undefined)).toEqual({ target: -20, source: "quietest" });
    expect(candidateTarget([-14, -20], -16)).toEqual({ target: -16, source: "given" });
  });

  it("warns only when a raise puts the true peak over the ceiling", () => {
    expect(peakWarning("a.wav", -3, 1)).toBeNull();
    expect(peakWarning("a.wav", -3, 4)).toContain("true peak at 1 dBTP");
    expect(peakWarning("a.wav", -0.5, -3)).toBeNull();
    expect(peakWarning("a.wav", null, 6)).toBeNull();
  });
});

describe("voice loudness", () => {
  it("is the energy mean of loudness plus gain, weighted by playing time", () => {
    expect(voiceLoudness([{ asset: "a", loudness: -20, gain: 0, seconds: 10 }])).toBe(-20);
    expect(voiceLoudness([{ asset: "a", loudness: -20, gain: 3, seconds: 5 }])).toBe(-17);
    // Equal time, 10 dB apart: the mean sits 7.4 dB below the louder one, not halfway.
    expect(voiceLoudness([
      { asset: "a", loudness: -10, gain: 0, seconds: 5 },
      { asset: "b", loudness: -20, gain: 0, seconds: 5 },
    ])).toBe(-12.6);
    // A short aside barely moves it.
    expect(
      voiceLoudness([
        { asset: "a", loudness: -20, gain: 0, seconds: 100 },
        { asset: "b", loudness: -10, gain: 0, seconds: 1 },
      ]),
    ).toBeLessThan(-19);
    expect(voiceLoudness([])).toBeNull();
  });

  const timeline = {
    tracks: [
      {
        id: "t_v",
        kind: "video",
        clips: [
          { id: "c_1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 10, speed: 2, audio: { gain: -3 } },
          { id: "c_2", type: "media", asset: "assets/muted.mp4", start: 5, in: 0, out: 4, audio: { muted: true } },
          { id: "c_3", type: "media", asset: "assets/silent.mp4", start: 9, in: 0, out: 4 },
          { id: "c_4", type: "media", asset: "assets/broken.mp4", start: 13, in: 0, out: 4 },
          { id: "c_5", type: "timeline", source: "timelines/x.json", start: 17 },
        ],
      },
      { id: "t_off", kind: "audio", muted: true, clips: [{ id: "c_6", type: "media", asset: "assets/off.wav", start: 0, in: 0, out: 3 }] },
    ],
  } as unknown as Timeline;

  it("reads the clips that play, at their gain and speed, and names the rest", async () => {
    const asked: string[] = [];
    const { parts, warnings } = await voiceParts(timeline, ["t_v", "t_off"], {
      async reading(asset) {
        asked.push(asset);
        if (asset.endsWith("silent.mp4")) return { integrated: null, range: null, truePeak: null };
        if (asset.endsWith("broken.mp4")) throw new Error("no decoder");
        return { integrated: -20, range: 5, truePeak: -3 };
      },
    });
    expect(parts).toEqual([{ asset: "assets/a.mp4", loudness: -20, gain: -3, seconds: 5 }]);
    expect(asked.sort()).toEqual(["assets/a.mp4", "assets/broken.mp4", "assets/silent.mp4"]);
    expect(warnings.join(" ")).toContain("silent.mp4 is silent");
    expect(warnings.join(" ")).toContain("broken.mp4 cannot be measured");
    expect(warnings.join(" ")).toContain("c_5 on t_v is a nested timeline");
  });

  it("fails, rather than names, when ffmpeg cannot be fetched", async () => {
    const reading = () => Promise.reject(new RpcError(ErrorCode.BinaryUnavailable, "no ffmpeg for this platform"));
    await expect(voiceParts(timeline, ["t_v"], { reading })).rejects.toMatchObject({ code: ErrorCode.BinaryUnavailable });
  });
});

describe("loudness cache", () => {
  it("is keyed by content and version, and gc sees its files and temps", () => {
    const key = loudnessCacheKey("sha256:0123456789abcdef0123456789abcdef");
    expect(key).toBe("0123456789abcdef0123-l1");
    expect(classifyLoudness(`${key}.json`, false)).toEqual({ kind: "loudness", key });
    expect(classifyLoudness(`${key}.json.123.ab12cd34.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyLoudness("0123456789abcdef0123-e1.f32", false)).toBeNull();
    expect(classifyLoudness("notes.txt", false)).toBeNull();
    expect(classifyLoudness(`${key}.json`, true)).toBeNull();
  });
});
