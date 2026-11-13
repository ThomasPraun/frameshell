import { ErrorCode, RpcError, parseParams } from "@frameshell/protocol";
import { type Clip, type Timeline, createTimeline, parseTimeline, resolveFormat } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, applyOperation, applyPatch } from "../src/index.js";

const FORMATS = [
  { id: "16x9", width: 1920, height: 1080 },
  { id: "9x16", width: 1080, height: 1920 },
  { id: "1x1", width: 1080, height: 1080 },
];
const PROJECT = { resolution: { width: 1920, height: 1080 }, formats: FORMATS };

function context(): EditContext {
  return {
    fps: 30,
    source: async () => ({ duration: 10, video: true, audio: true }),
    nestedDuration: async () => 0,
    clipTypes: async () =>
      new Map([
        [
          "hyperframes",
          { validateProps: async (props: Record<string, unknown>) => (typeof props["title"] === "string" ? null : "title: expected string"), elementStyles: true },
        ],
      ]),
    newId: (prefix) => `${prefix}_0001`,
    formats: FORMATS,
  };
}

function op(name: string, args: Record<string, unknown>): OperationRequest {
  const { cwd: _cwd, timeline: _timeline, ...parsed } = parseParams(name as "clip.set", { cwd: process.cwd(), ...args }) as Record<string, unknown>;
  return { op: name, args: parsed } as OperationRequest;
}

const apply = (timeline: Timeline, name: string, args: Record<string, unknown>) => applyOperation(timeline, op(name, args), context());

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Footage on the base track, a title card and a logo above, music, and captions of the footage. */
function reel(): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [
      { id: "t_v", kind: "video", clips: [{ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 6 }] },
      {
        id: "t_top",
        kind: "video",
        clips: [
          { id: "c_title", type: "hyperframes", start: 0, duration: 3, transform: { y: 380, scale: 0.8 }, props: { title: "Launch" } },
          { id: "c_logo", type: "media", asset: "assets/talk.mp4", start: 3, in: 0, out: 2, keys: { x: [{ at: 0, value: -100 }, { at: 2, value: 100 }] } },
        ],
      },
      { id: "t_a", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 6 }] },
      { id: "t_s", kind: "subtitles", follows: "t_v", style: { preset: "plain", position: "bottom" } },
    ],
  };
}

function clip(timeline: Timeline, id: string): Clip {
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const found = track.clips.find((candidate) => candidate.id === id);
    if (found) return found;
  }
  throw new Error(`no clip ${id}`);
}

describe("clip.set with format (ADR 0027 decision 5)", () => {
  it("stores placement in that format's override and leaves the clip and the primary as they are", async () => {
    const { timeline, inverse } = await apply(reel(), "clip.set", { clip: "c_title", format: "9x16", transform: { y: 700 } });
    expect(clip(timeline, "c_title")).toMatchObject({ transform: { y: 380, scale: 0.8 }, formats: { "9x16": { transform: { y: 700 } } } });
    expect(parseTimeline(timeline).ok).toBe(true);
    expect(resolveFormat(timeline, PROJECT)!.timeline).toBe(timeline);
    expect(clip(resolveFormat(timeline, PROJECT, "9x16")!.timeline, "c_title")).toMatchObject({ transform: { y: 700, scale: 0.8 } });
    expect(clip(resolveFormat(timeline, PROJECT, "1x1")!.timeline, "c_title")).toMatchObject({ transform: { y: 380 } });
    // The inverse is an ordinary patch: undo drops the override and `formats` with it.
    expect(clip(applyPatch(timeline, inverse.args), "c_title")).not.toHaveProperty("formats");
  });

  it("merges transform fields, replaces props checked over the clip's own, hides and shows, and resets", async () => {
    let { timeline } = await apply(reel(), "clip.set", { clip: "c_title", format: "9x16", transform: { y: 700 } });
    ({ timeline } = await apply(timeline, "clip.set", { clip: "c_title", format: "9x16", transform: { scale: 1.1 }, props: { size: 110 } }));
    expect(clip(timeline, "c_title").formats).toEqual({ "9x16": { transform: { y: 700, scale: 1.1 }, props: { size: 110 } } });
    ({ timeline } = await apply(timeline, "clip.set", { clip: "c_logo", format: "9x16", hidden: true }));
    expect(clip(timeline, "c_logo").formats).toEqual({ "9x16": { hidden: true } });
    ({ timeline } = await apply(timeline, "clip.set", { clip: "c_logo", format: "9x16", hidden: false }));
    expect(clip(timeline, "c_logo")).not.toHaveProperty("formats");
    ({ timeline } = await apply(timeline, "clip.set", { clip: "c_title", format: "9x16", reset: true, transform: { x: 40 } }));
    expect(clip(timeline, "c_title").formats).toEqual({ "9x16": { transform: { x: 40 } } });
    ({ timeline } = await apply(timeline, "clip.set", { clip: "c_title", format: "9x16", reset: true }));
    expect(clip(timeline, "c_title")).not.toHaveProperty("formats");
  });

  it("checks props over the clip's own and merges elements per selector", async () => {
    const bad = await rejection(apply(reel(), "clip.set", { clip: "c_title", format: "9x16", props: { title: 3 } }));
    expect(bad.message).toMatch(/invalid props for hyperframes in format 9x16: title/);
    const { timeline } = await apply(reel(), "clip.set", { clip: "c_title", format: "9x16", elements: { "#title": { y: -40 } } });
    const { timeline: next } = await apply(timeline, "clip.set", { clip: "c_title", format: "9x16", elements: { "#title": null, ".badge": { scale: 1.2 } } });
    expect(clip(next, "c_title").formats).toEqual({ "9x16": { elements: { ".badge": { scale: 1.2 } } } });
  });

  it("refuses timing and sound, the primary, unknown formats, audio tracks, footage props and shots-only fields without format", async () => {
    const shared = await rejection(apply(reel(), "clip.set", { clip: "c_talk", format: "9x16", gain: -6, transform: { x: 1 } }));
    expect(shared.message).toMatch(/`gain` is shared by every format/);
    const primary = await rejection(apply(reel(), "clip.set", { clip: "c_title", format: "16x9", transform: { y: 1 } }));
    expect(primary.message).toMatch(/16x9 is the primary format/);
    const unknown = await rejection(apply(reel(), "clip.set", { clip: "c_title", format: "4x5", transform: { y: 1 } }));
    expect(unknown.code).toBe(ErrorCode.FormatNotFound);
    const sound = await rejection(apply(reel(), "clip.set", { clip: "c_music", format: "9x16", transform: { y: 1 } }));
    expect(sound.message).toMatch(/audio tracks have no picture to change per format/);
    const footage = await rejection(apply(reel(), "clip.set", { clip: "c_talk", format: "9x16", props: { title: "x" } }));
    expect(footage.message).toMatch(/only adapter clips take `props`/);
    const loose = await rejection(apply(reel(), "clip.set", { clip: "c_talk", hidden: true }));
    expect(loose.message).toMatch(/`hidden` belongs to one format: give `format` too/);
    const empty = await rejection(apply(reel(), "clip.set", { clip: "c_talk", format: "9x16" }));
    expect(empty.message).toMatch(/nothing to set in format 9x16/);
    const unmoved = await rejection(apply(reel(), "clip.set", { clip: "c_talk", format: "9x16", transform: {} }));
    expect(unmoved.message).toMatch(/nothing to set in format 9x16/);
    const nothingToReset = await rejection(apply(reel(), "clip.set", { clip: "c_talk", format: "9x16", reset: true }));
    expect(nothingToReset.message).toMatch(/nothing to set in format 9x16/);
    const unstyled = await rejection(apply(reel(), "track.set", { track: "t_s", format: "9x16", reset: true }));
    expect(unstyled.message).toMatch(/nothing to set in format 9x16/);
    expect((await rejection(apply(reel(), "track.set", { track: "t_s", format: "9x16", style: {} }))).message).toMatch(/nothing to set in format 9x16/);
  });
});

describe("clip.key with format", () => {
  it("starts the format's keys from the clip's own, keeps the clip's, and clear goes back to them", async () => {
    // c_logo: x keyed -100 at its start (3 s) to 100 at its end (5 s).
    let { timeline } = await apply(reel(), "clip.key", { clip: "c_logo", format: "9x16", prop: "x", time: 4, value: 0 });
    expect(clip(timeline, "c_logo").keys).toEqual({ x: [{ at: 0, value: -100 }, { at: 2, value: 100 }] });
    expect(clip(timeline, "c_logo").formats).toEqual({ "9x16": { keys: { x: [{ at: 0, value: -100 }, { at: 1, value: 0 }, { at: 2, value: 100 }] } } });
    // A new key without a value takes what plays in the format there.
    ({ timeline } = await apply(timeline, "clip.key", { clip: "c_title", format: "9x16", prop: "y", time: 1 }));
    expect(clip(timeline, "c_title").formats).toEqual({ "9x16": { keys: { y: [{ at: 1, value: 380 }] } } });
    ({ timeline } = await apply(timeline, "clip.key", { clip: "c_logo", format: "9x16", prop: "x", clear: true }));
    expect(clip(timeline, "c_logo")).not.toHaveProperty("formats");
    expect(clip(timeline, "c_logo").keys).toEqual({ x: [{ at: 0, value: -100 }, { at: 2, value: 100 }] });
    expect(parseTimeline(timeline).ok).toBe(true);
  });

  it("refuses gain in a format", async () => {
    const gain = await rejection(apply(reel(), "clip.key", { clip: "c_talk", format: "9x16", prop: "gain", time: 1, value: -3 }));
    expect(gain.message).toMatch(/sound is shared by every format/);
  });
});

describe("track.set with format", () => {
  it("sets a subtitle track's style in that format, field by field, and reset drops it", async () => {
    let { timeline } = await apply(reel(), "track.set", { track: "t_s", format: "9x16", style: { position: "center" } });
    ({ timeline } = await apply(timeline, "track.set", { track: "t_s", format: "9x16", style: { entry: "words" } }));
    const track = timeline.tracks[3]!;
    expect(track).toMatchObject({ style: { preset: "plain", position: "bottom" }, formats: { "9x16": { style: { position: "center", entry: "words" } } } });
    expect(resolveFormat(timeline, PROJECT, "9x16")!.timeline.tracks[3]).toMatchObject({ style: { preset: "plain", position: "center", entry: "words" } });
    expect(parseTimeline(timeline).ok).toBe(true);
    ({ timeline } = await apply(timeline, "track.set", { track: "t_s", format: "9x16", reset: true }));
    expect(timeline.tracks[3]).not.toHaveProperty("formats");
  });

  it("refuses clip tracks and shared fields", async () => {
    const clips = await rejection(apply(reel(), "track.set", { track: "t_v", format: "9x16", style: { position: "top" } }));
    expect(clips.message).toMatch(/per format, tracks take only a subtitle `style`/);
    const shared = await rejection(apply(reel(), "track.set", { track: "t_s", format: "9x16", gaps: [] }));
    expect(shared.message).toMatch(/`gaps` is shared by every format/);
  });
});
