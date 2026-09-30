import type { Clip } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditPoint, energyEnvelope, energyProfile, energySnapper } from "../src/index.js";
import { speechLike, voicedAt } from "./speech-fixture.js";

// Seam under test: energySnapper(options) as the engine's EditPointResolver.
// Profiles come from in-memory synthetic speech; no files, no ffmpeg.

const profile = energyProfile(energyEnvelope(speechLike(16_000), 16_000));
const assets: Record<string, boolean> = { "assets/talk.wav": true, "assets/screen.mp4": false };
const loaded: string[] = [];
const snapper = energySnapper({
  fps: 30,
  hasAudio: async (asset) => assets[asset] ?? false,
  profile: async (asset) => {
    loaded.push(asset);
    return profile;
  },
});

const media = (id: string, asset: string, start: number, clipIn: number, out: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset, start, in: clipIn, out, ...extra }) as Clip;

const point = (p: Partial<EditPoint> & Pick<EditPoint, "time">): EditPoint => ({ clock: "timeline", edge: "end", window: 0.5, ...p });

describe("energySnapper", () => {
  it("maps cut times through the clip under the edge (start, in, speed)", async () => {
    // Timeline 10 = source 0.5; source 0.75 is in the word ending at 0.8, pause 0.8-1.1.
    const clip = media("c_1", "assets/talk.wav", 10, 0.5, 8);
    const result = await snapper(point({ time: 10.25, clips: [clip] }));
    expect(result?.clean).toBe(true);
    expect(voicedAt(result!.time - 10 + 0.5)).toBe(false);
    expect(result!.time).toBeGreaterThan(10.3);

    const fast = media("c_2", "assets/talk.wav", 0, 0, 8, { speed: 2 } as Partial<Clip>);
    const sped = await snapper(point({ time: 0.36, clips: [fast] })); // source 0.72
    expect(sped?.clean).toBe(true);
    expect(voicedAt(sped!.time * 2)).toBe(false);
  });

  it("snaps trims by source time on the clip's own asset", async () => {
    const clip = media("c_1", "assets/talk.wav", 10, 0, 8);
    const result = await snapper(point({ time: 2.4, clock: "source", edge: "start", clip }));
    expect(result).toMatchObject({ clean: true });
    expect(voicedAt(result!.time)).toBe(false);
  });

  it("declines edges with no audible audio: video-only, muted, non-media, nothing under the edge", async () => {
    loaded.length = 0;
    expect(await snapper(point({ time: 1, clips: [media("c_1", "assets/screen.mp4", 0, 0, 8)] }))).toBeNull();
    expect(await snapper(point({ time: 1, clips: [media("c_1", "assets/talk.wav", 0, 0, 8, { audio: { muted: true } })] }))).toBeNull();
    expect(await snapper(point({ time: 1, clip: { id: "c_9", type: "hyperframes", start: 0, duration: 5 } as Clip }))).toBeNull();
    expect(await snapper(point({ time: 30, clips: [media("c_1", "assets/talk.wav", 0, 0, 8)] }))).toBeNull();
    expect(loaded).toEqual([]);
  });

  it("turns an unreadable asset into an actionable error naming --no-snap", async () => {
    const broken = energySnapper({
      fps: 30,
      hasAudio: async () => true,
      profile: async () => {
        throw new Error("ffmpeg exited 1");
      },
    });
    const clip = media("c_1", "assets/talk.wav", 0, 0, 8);
    await expect(broken(point({ time: 1, clips: [clip] }))).rejects.toThrow(
      /could not read the audio of assets\/talk\.wav: ffmpeg exited 1.*--no-snap/,
    );
  });

  it("treats a timeline gap next to a clip as silence", async () => {
    // Clip holds the long word (source 3.5-7.0) at timeline 0-3.5; nothing after 3.5.
    const clip = media("c_1", "assets/talk.wav", 0, 3.5, 7);
    const result = await snapper(point({ time: 3.2, clips: [clip] }));
    expect(result?.clean).toBe(true);
    expect(result!.time).toBeGreaterThanOrEqual(3.5);
  });
});
