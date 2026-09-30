import { type Clip, type ClipTrack, type MediaClip, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type EditContext,
  type EditPoint,
  type OperationRequest,
  applyOperation,
  energyEnvelope,
  energyProfile,
  energySnapper,
} from "../src/index.js";
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

const RATE = 16_000;
/** Snapper over {@link continuousSpeech}: inter-word gaps shorter than a pause. */
const tight = energySnapper({
  fps: 30,
  hasAudio: async () => true,
  profile: async () => energyProfile(energyEnvelope(continuousSpeech(), RATE)),
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

  it("keeps a bounded source edge inside its range when inter-word gaps are shorter than a pause", async () => {
    const clip = media("c_1", "assets/talk.wav", 0, 0, 2.95);
    // Unbounded, the nearest pause is the one before W: extending the tail there leaves W cut.
    const loose = await tight(point({ time: 3.54, clock: "source", clip }));
    expect(loose!.time).toBeLessThan(3.35);
    // Bounded to the gap after W: no pause fits, so the quietest in-range frame, reported unclean.
    const bounded = await tight(point({ time: 3.54, clock: "source", clip, min: 3.5, max: 3.58 }));
    expect(bounded!.clean).toBe(false);
    expect(bounded!.time).toBeGreaterThanOrEqual(3.5);
    expect(bounded!.time).toBeLessThanOrEqual(3.58);
    // A range that holds a real pause still snaps clean into it.
    const roomy = await tight(point({ time: 3.95, clock: "source", clip, min: 3.9, max: 4.3 }));
    expect(roomy!.clean).toBe(true);
    expect(roomy!.time).toBeGreaterThan(3.9);
  });

  it("restores a word in continuous speech through the engine: a fenced rippled trim keeps W and leaves the next word cut", async () => {
    // c_1 plays up to the pause before W; c_2 resumes after the next word.
    const timeline = createTimeline("main");
    timeline.tracks.push({
      id: "t_v",
      kind: "video",
      clips: [media("c_1", "assets/talk.wav", 0, 2.4, 3), media("c_2", "assets/talk.wav", 0.6, 3.933, 5)],
    });
    const ctx: EditContext = {
      fps: 30,
      source: async () => ({ duration: 5, video: true, audio: true }),
      nestedDuration: async () => 0,
      clipTypes: async () => new Map(),
      newId: (prefix) => `${prefix}_new`,
      resolveEditPoint: tight,
    };
    const request = (bounded: boolean): OperationRequest => ({
      op: "clip.trim",
      args: { clip: "c_1", out: 3.54, ripple: true, ...(bounded ? { snapBounds: { out: { min: 3.5, max: 3.58 } } } : {}) },
    });
    // Unfenced, the snap lands in the pause before W (3.35 is its midpoint): W stays cut.
    const loose = await applyOperation(timeline, request(false), ctx);
    expect(((loose.timeline.tracks[0] as ClipTrack).clips[0] as MediaClip).out).toBeLessThan(3.35);
    // Fenced: W (to 3.5) is back, the next word (from 3.58, midpoint 3.74) is not.
    const fenced = await applyOperation(timeline, request(true), ctx);
    const [first, second] = (fenced.timeline.tracks[0] as ClipTrack).clips as MediaClip[];
    expect(first!.out).toBeGreaterThanOrEqual(3.5);
    expect(first!.out).toBeLessThanOrEqual(3.58);
    expect(fenced.snaps).toMatchObject([{ field: "out", requested: 3.54, clean: false }]);
    // Rippled: c_2 still follows c_1 directly.
    expect(second!.start).toBeCloseTo(first!.out - 2.4, 3);
  });
});

/** Continuous speech: word 2.5-2.9, pause 2.9-3.2, W 3.2-3.5, 80 ms gap, next word 3.58-3.9, pause 3.9-4.3, word 4.3-4.8. */
function continuousSpeech(): Int16Array {
  const words = [
    [2.5, 2.9],
    [3.2, 3.5],
    [3.58, 3.9],
    [4.3, 4.8],
  ] as const;
  const pcm = new Int16Array(5 * RATE);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    pcm[i] = words.some(([a, b]) => t >= a && t < b) ? Math.round(0.3 * Math.sin(2 * Math.PI * 220 * t) * 32767) : 0;
  }
  return pcm;
}
