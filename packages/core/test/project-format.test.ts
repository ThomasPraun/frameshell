import { describe, expect, it } from "vitest";
import type { MediaProbe } from "@frameshell/protocol";
import { projectFormat } from "../src/media/format.js";

function probe(video: Partial<NonNullable<MediaProbe["video"]>> | null, audio: number | null = 48000): MediaProbe {
  return {
    duration: 10,
    format: "mov,mp4",
    video: video ? { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false, ...video } : null,
    audio: audio === null ? null : { codec: "aac", sampleRate: audio, channels: 2 },
  };
}

describe("projectFormat", () => {
  it("takes size, frame rate and sample rate from the video", () => {
    expect(projectFormat(probe({ width: 3840, height: 2160, fps: 59.94 }, 48000))).toEqual({
      resolution: { width: 3840, height: 2160 },
      fps: 59.94,
      sampleRate: 48000,
    });
  });

  it("keeps a phone's portrait size and snaps its variable rate to the standard one", () => {
    expect(projectFormat(probe({ width: 1080, height: 1920, fps: 29.62, vfr: true }, 44100))).toEqual({
      resolution: { width: 1080, height: 1920 },
      fps: 29.97,
      sampleRate: 44100,
    });
  });

  it("rounds odd sizes down to even, an odd rate to whole frames, and an odd sample rate to 48 kHz", () => {
    expect(projectFormat(probe({ width: 1279, height: 721, fps: 15.2 }, 22050))).toEqual({
      resolution: { width: 1278, height: 720 },
      fps: 15,
      sampleRate: 48000,
    });
  });

  it("leaves out what an audio file or a still image cannot tell", () => {
    expect(projectFormat(probe(null, 48000))).toEqual({ sampleRate: 48000 });
    expect(projectFormat(probe({ still: true, fps: null }, null))).toEqual({});
  });
});
