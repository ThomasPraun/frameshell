import { describe, expect, it } from "vitest";
import {
  AUDIO_TYPES,
  LEVEL_FLOOR,
  SILENCE_WARN_MS,
  VIDEO_TYPES,
  capSize,
  elapsedLabel,
  levelDb,
  meterFill,
  pickType,
  silentSince,
  silentTooLong,
} from "../src/renderer/src/shoot/model.js";

describe("pickType", () => {
  it("prefers H.264 + AAC in MP4 and falls back to WebM VP9 + Opus", () => {
    expect(pickType("video", () => true)).toBe("video/mp4;codecs=avc1.640028");
    expect(pickType("audio", () => true)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickType("video", (type) => type.startsWith("video/webm"))).toBe("video/webm;codecs=vp9");
    expect(pickType("audio", (type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickType("video", () => false)).toBeNull();
    expect([...VIDEO_TYPES, ...AUDIO_TYPES].some((type) => type.includes("opus") && type.includes("mp4"))).toBe(false);
  });
});

describe("capSize", () => {
  it("scales a Retina screen down to 1440 on its shorter side, even and in proportion", () => {
    expect(capSize(3024, 1964)).toEqual({ width: 2218, height: 1440 });
    expect(capSize(1964, 3024)).toEqual({ width: 1440, height: 2218 });
    expect(capSize(2560, 1440)).toBeNull();
    expect(capSize(1920, 1080)).toBeNull();
  });
});

describe("levels", () => {
  it("measures RMS in dBFS with a floor for silence", () => {
    expect(levelDb(new Float32Array(128))).toBe(LEVEL_FLOOR);
    expect(levelDb(new Float32Array(128).fill(1))).toBeCloseTo(0, 6);
    expect(levelDb(new Float32Array(128).fill(0.1))).toBeCloseTo(-20, 4);
    expect(levelDb([])).toBe(LEVEL_FLOOR);
    expect(meterFill(-100)).toBe(0);
    expect(meterFill(-30)).toBeCloseTo(0.5);
    expect(meterFill(3)).toBe(1);
  });

  it("warns once system audio has been silent for 10 s, and forgets the silence at the first sound", () => {
    let since = silentSince(null, -91, 1000);
    expect(since).toBe(1000);
    since = silentSince(since, -91, 5000);
    expect(since).toBe(1000);
    expect(silentTooLong(since, 1000 + SILENCE_WARN_MS - 1)).toBe(false);
    expect(silentTooLong(since, 1000 + SILENCE_WARN_MS)).toBe(true);
    expect(silentSince(since, -20, 12_000)).toBeNull();
    expect(silentTooLong(null, 1e9)).toBe(false);
  });
});

describe("elapsedLabel", () => {
  it("shows minutes and seconds, hours from an hour", () => {
    expect(elapsedLabel(0)).toBe("0:00");
    expect(elapsedLabel(61_900)).toBe("1:01");
    expect(elapsedLabel(3_725_000)).toBe("1:02:05");
  });
});
