import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { classifyLoudness, loudnessCacheKey } from "../src/media/loudness-store.js";
import { MAX_VOICE_RANGES, candidateTarget, gainFor, peakWarning, planLevels, playedRange, voiceLoudness, voiceParts } from "../src/media/loudness-plan.js";

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
      fps: 30,
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
    await expect(voiceParts(timeline, ["t_v"], { fps: 30, reading })).rejects.toMatchObject({ code: ErrorCode.BinaryUnavailable });
  });
});

describe("loudness cache", () => {
  it("is keyed by content and version, and gc sees its files and temps", () => {
    const key = loudnessCacheKey("sha256:0123456789abcdef0123456789abcdef");
    expect(key).toBe("0123456789abcdef0123-l1");
    expect(classifyLoudness(`${key}.json`, false)).toEqual({ kind: "loudness", key });
    // A reading of a part of the file is kept or swept with the content it is of.
    expect(classifyLoudness(`${key}-r1000-9500.json`, false)).toEqual({ kind: "loudness", key });
    expect(classifyLoudness(`${key}-r1000-9500.json.123.ab12cd34.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyLoudness(`${key}.json.123.ab12cd34.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyLoudness("0123456789abcdef0123-e1.f32", false)).toBeNull();
    expect(classifyLoudness("notes.txt", false)).toBeNull();
    expect(classifyLoudness(`${key}.json`, true)).toBeNull();
  });
});

describe("the part of a file a clip plays", () => {
  it("is in to out, on whole frames", () => {
    expect(playedRange({ in: 1.5, out: 9 }, 30)).toEqual({ start: 1.5, end: 9 });
    // 20.345 s at 30 fps is frame 610.35: the nearest frame.
    expect(playedRange({ in: 20.345, out: 26 }, 30).start).toBeCloseTo(610 / 30, 9);
  });

  const clip = (id: string, asset: string, from: number, to: number) => ({ id, type: "media", asset, start: 0, in: from, out: to });
  const reads: [string, { start: number; end: number } | undefined][] = [];
  const reading = async (asset: string, range?: { start: number; end: number }) => {
    reads.push([asset, range]);
    // 10 dB louder in the second half of the file: the reading depends on the part asked.
    const loud = range !== undefined && range.start >= 5;
    return { integrated: asset.endsWith("voice.wav") ? -20 : loud ? -14 : -24, range: 3, truePeak: -2 };
  };
  const timeline = {
    tracks: [
      { id: "t_v", kind: "audio", clips: [clip("c_v", "assets/voice.wav", 0, 10)] },
      { id: "t_m", kind: "audio", clips: [clip("c_m", "assets/song.wav", 5, 20), { ...clip("c_k", "assets/song.wav", 0, 4), keys: { gain: [{ time: 1, value: -3 }] } }] },
    ],
  } as unknown as Timeline;

  it("measures the music over the part its clip plays, the voice over its own, and leaves a clip with keys of its own", async () => {
    reads.length = 0;
    const plan = await planLevels(timeline, 30, { track: "t_m", under: ["t_v"], level: 12 }, { reading });
    expect(plan.voice).toBe(-20);
    expect(plan.target).toBe(-32);
    // The second half of the song is -14 LUFS: -18 dB brings it to the target (the whole file's average would be -24).
    expect(plan.clips).toEqual([{ clip: "c_m", loudness: -14, gain: -18 }]);
    expect(plan.warnings.join(" ")).toContain("c_k has gain keys of its own");
    expect(reads).toContainEqual(["assets/song.wav", { start: 5, end: 20 }]);
    expect(reads).toContainEqual(["assets/voice.wav", { start: 0, end: 10 }]);
  });

  it("keeps a clip's own keys out of the way unless the caller writes those keys again", async () => {
    const shaped = {
      tracks: [timeline.tracks[0], { id: "t_m", kind: "audio", clips: [{ ...clip("c_m", "assets/song.wav", 5, 20), keys: { gain: [{ time: 1, value: -3, auto: "music" }] } }] }],
    } as unknown as Timeline;
    const ask = (replaced?: ReadonlySet<string>) => planLevels(shaped, 30, { track: "t_m", under: ["t_v"], level: 12, replaced }, { reading });
    expect((await ask()).clips).toEqual([]);
    expect((await ask(new Set(["duck", "music"]))).clips.map((entry) => entry.clip)).toEqual(["c_m"]);
    // Only the clips asked for.
    expect((await planLevels(timeline, 30, { track: "t_m", under: ["t_v"], level: 12, only: new Set(["c_k"]) }, { reading })).clips).toEqual([]);
  });

  it("reads a voice file cut into many pieces whole, not once per piece", async () => {
    const pieces = Array.from({ length: MAX_VOICE_RANGES + 1 }, (_, i) => clip(`c_${i}`, "assets/voice.wav", i, i + 1));
    const cut = { tracks: [{ id: "t_v", kind: "audio", clips: pieces }] } as unknown as Timeline;
    reads.length = 0;
    const { parts } = await voiceParts(cut, ["t_v"], { fps: 30, reading });
    expect(parts).toHaveLength(MAX_VOICE_RANGES + 1);
    expect(reads).toEqual([["assets/voice.wav", undefined]]);
  });
});
