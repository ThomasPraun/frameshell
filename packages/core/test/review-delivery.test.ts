import type { MediaProbe } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { deliveryChecks, deliveryWarnings, rational } from "../src/review/delivery.js";
import { judgeSeam, seamVerdict } from "../src/review/loop.js";

// The delivery check against the export plan, and the verdicts on a loop's seam (#457).

const plan = { width: 1920, height: 1080, fps: "30/1", duration: 10, loudness: -17 };
const preset = { video: { codec: "h264" as const, width: 1920, height: 1080 }, audio: { codec: "aac" as const } };
const loud = { integrated: -17.3, range: 4, truePeak: -2, phoneBand: -18 };

function probe(extra: Partial<MediaProbe> = {}): MediaProbe {
  return {
    duration: 10.02,
    format: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false, alpha: false },
    audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    ...extra,
  };
}

const failing = (checks: ReturnType<typeof deliveryChecks>) => checks.filter((check) => !check.ok).map((check) => check.field);

describe("review delivery", () => {
  it("a file as planned passes every check", () => {
    expect(failing(deliveryChecks(plan, preset, probe(), loud))).toEqual([]);
    expect(deliveryChecks(plan, preset, probe(), loud).map((check) => check.field)).toEqual(["width", "height", "fps", "duration", "codec", "audio", "loudness"]);
  });

  it("names what differs: size, frame rate, length beyond 2 frames, codec, audio, loudness beyond 1.5 LU", () => {
    expect(failing(deliveryChecks(plan, preset, probe({ video: { ...probe().video!, width: 1280, height: 720 } }), loud))).toEqual(["width", "height"]);
    expect(failing(deliveryChecks(plan, preset, probe({ video: { ...probe().video!, fps: 29.97 } }), loud))).toEqual(["fps"]);
    expect(failing(deliveryChecks(plan, preset, probe({ duration: 10.08 }), loud))).toEqual(["duration"]);
    expect(failing(deliveryChecks(plan, preset, probe({ duration: 10.06 }), loud))).toEqual([]);
    expect(failing(deliveryChecks(plan, preset, probe({ video: { ...probe().video!, codec: "hevc" } }), loud))).toEqual(["codec"]);
    expect(failing(deliveryChecks(plan, preset, probe({ audio: null }), null))).toEqual(["audio"]);
    expect(failing(deliveryChecks(plan, preset, probe(), { ...loud, integrated: -14.1 }))).toEqual(["loudness"]);
  });

  it("an NTSC plan matches the rational frame rate, and a silent file is not measured against the loudness target", () => {
    expect(rational("30000/1001")).toBeCloseTo(29.97, 2);
    expect(rational("x")).toBeNaN();
    const ntsc = { ...plan, fps: "30000/1001" };
    expect(failing(deliveryChecks(ntsc, preset, probe({ video: { ...probe().video!, fps: 30000 / 1001 } }), loud))).toEqual([]);
    expect(deliveryChecks(plan, preset, probe(), { ...loud, integrated: null }).some((check) => check.field === "loudness")).toBe(false);
  });

  it("a gif preset expects no audio and the gif codec", () => {
    const gif = { video: { codec: "gif" as const, width: 1200, height: 675 } };
    const file = probe({ audio: null, video: { ...probe().video!, codec: "gif" } });
    expect(failing(deliveryChecks({ ...plan, width: 1920, height: 1080 }, gif, file, null))).toEqual([]);
    expect(deliveryChecks(plan, gif, probe(), null).find((check) => check.field === "audio")).toMatchObject({ expected: "none", actual: "aac", ok: false });
  });

  it("one craft warning lists everything that differs, none when it all holds", () => {
    const checks = deliveryChecks(plan, preset, probe({ duration: 12, audio: null }), null);
    const warnings = deliveryWarnings({ timeline: "main", preset: "youtube-1080p", format: "16x9", bytes: 1, checks });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ check: "delivery", from: null, to: null });
    expect(warnings[0]!.message).toContain("duration is 12, the plan says 10");
    expect(warnings[0]!.message).toContain("audio is none, the plan says aac");
    expect(deliveryWarnings({ timeline: "main", preset: "youtube-1080p", format: "16x9", bytes: 1, checks: deliveryChecks(plan, preset, probe(), loud) })).toEqual([]);
  });
});

describe("review loop seam", () => {
  const grey = (level: number) => new Uint8Array(100).fill(level);

  it("a last frame that repeats the first while the picture moves is a duplicate, by the render's own test", () => {
    expect(judgeSeam(grey(10), grey(40), grey(80), grey(10))).toEqual({ jump: 0, duplicate: true });
    // A picture that never moves has no seam to repeat.
    expect(judgeSeam(grey(10), grey(10), grey(11), grey(10))).toEqual({ jump: 0, duplicate: false });
    // 0.5 levels is no longer the same picture.
    expect(judgeSeam(grey(10), grey(40), grey(80), grey(11)).duplicate).toBe(false);
  });

  it("a duplicate is a duplicate; otherwise under 10 grey levels reads continuous, 10 or more is a cut", () => {
    expect(seamVerdict(0.1, true)).toBe("duplicate");
    expect(seamVerdict(0.1, false)).toBe("continuous");
    expect(seamVerdict(0.5, false)).toBe("continuous");
    expect(seamVerdict(9.9, false)).toBe("continuous");
    expect(seamVerdict(10, false)).toBe("cut");
    expect(seamVerdict(60, false)).toBe("cut");
  });
});
