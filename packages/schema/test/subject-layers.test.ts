import { describe, expect, it } from "vitest";
import { type Clip, type ClipTrack, type Timeline, type Track, flattenTimeline, isSubjectClip, withSubjectLayers } from "../src/index.js";

const talk = (id: string, start: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset: "assets/talk.mp4", start, in: 2, out: 5, audio: { gain: -3 }, ...extra }) as Clip;

/** Plate v1 (two talk clips and a nested clip), title v2 behind it, logo v3, music a1. */
function stack(overrides: Partial<Record<"v1" | "v2" | "v3", Partial<ClipTrack>>> = {}): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [talk("c_a", 0, { fadeIn: 0.5 }), talk("c_b", 3, { dissolve: 0.4, transform: { scale: 0.8 } }), { id: "c_n", type: "timeline", source: "timelines/intro.json", start: 6, duration: 2 }],
        ...overrides.v1,
      },
      { id: "a1", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 8 }] },
      { id: "v2", kind: "video", behind: "v1", clips: [{ id: "c_t", type: "media", asset: "assets/title.png", start: 1, in: 0, out: 3 }], ...overrides.v2 },
      { id: "v3", kind: "video", clips: [{ id: "c_l", type: "media", asset: "assets/logo.png", start: 0, in: 0, out: 8 }], ...overrides.v3 },
    ],
  };
}

const ids = (timeline: Timeline) => timeline.tracks.map((track) => track.id);
const clipsOf = (track: Track | undefined) => (track as ClipTrack).clips;

describe("withSubjectLayers (ADR 0032)", () => {
  it("adds the plate's media clips, muted and marked, right above the track behind it", () => {
    const timeline = stack();
    const lifted = withSubjectLayers(timeline);
    expect(ids(lifted)).toEqual(["v1", "a1", "v2", "v2/subject", "v3"]);
    const subject = lifted.tracks[3] as ClipTrack;
    expect(subject).toMatchObject({ id: "v2/subject", kind: "video", muted: true });
    // Same ids and picture fields as the plate's; nested clips have no matte. The mark never reaches JSON.
    expect(JSON.parse(JSON.stringify(subject.clips))).toEqual([
      { ...talk("c_a", 0, { fadeIn: 0.5 }), audio: { muted: true } },
      { ...talk("c_b", 3, { dissolve: 0.4, transform: { scale: 0.8 } }), audio: { muted: true } },
    ]);
    expect(subject.clips.every(isSubjectClip)).toBe(true);
    expect(clipsOf(timeline.tracks[0]).some(isSubjectClip)).toBe(false);
    expect(isSubjectClip(JSON.parse(JSON.stringify(subject.clips[0])) as Clip)).toBe(false);
  });

  it("returns the timeline itself when no track is behind one, and adds nothing for a hidden track or plate", () => {
    const plain = stack();
    delete (plain.tracks[2] as ClipTrack).behind;
    expect(withSubjectLayers(plain)).toBe(plain);
    expect(ids(withSubjectLayers(stack({ v2: { hidden: true } })))).toEqual(["v1", "a1", "v2", "v3"]);
    expect(ids(withSubjectLayers(stack({ v1: { hidden: true } })))).toEqual(["v1", "a1", "v2", "v3"]);
  });

  it("gives a run of tracks behind the same plate one layer above the last, hidden tracks between them included", () => {
    expect(ids(withSubjectLayers(stack({ v3: { behind: "v1" } })))).toEqual(["v1", "a1", "v2", "v3", "v3/subject"]);
    const between: Timeline = { ...stack({ v3: { behind: "v1" } }) };
    between.tracks.splice(3, 0, { id: "v_h", kind: "video", hidden: true, clips: [] });
    expect(ids(withSubjectLayers(between))).toEqual(["v1", "a1", "v2", "v_h", "v3", "v3/subject"]);
    // A shown track in between is in front of the person: each run gets its own layer.
    between.tracks[3] = { id: "v_h", kind: "video", clips: [] };
    expect(ids(withSubjectLayers(between))).toEqual(["v1", "a1", "v2", "v2/subject", "v_h", "v3", "v3/subject"]);
  });

  it("runs inside flattenTimeline after track mutes, at every nesting level", () => {
    const intro: Timeline = {
      schemaVersion: 1,
      id: "intro",
      revision: 1,
      tracks: [
        { id: "p", kind: "video", muted: true, clips: [talk("c_x", 0)] },
        { id: "w", kind: "video", behind: "p", clips: [{ id: "c_w", type: "media", asset: "assets/word.png", start: 0, in: 0, out: 2 }] },
      ],
    };
    const flat = flattenTimeline(stack(), (source) => (source === "timelines/intro.json" ? intro : null), 30);
    // The nested plate goes onto v1, its word onto v1/2 and its subject layer onto v1/3, above it.
    expect(ids(flat)).toEqual(["v1", "v1/2", "v1/3", "a1", "v2", "v2/subject", "v3"]);
    const nested = clipsOf(flat.tracks[2]);
    expect(nested.map((clip) => clip.id)).toEqual(["c_n/c_x"]);
    expect(nested.every(isSubjectClip)).toBe(true);
    expect(nested[0]).toMatchObject({ start: 6, in: 2, out: 4, audio: { muted: true } });
    // The root's subject layer copies the plate as stored: the nested clip is not lifted.
    expect(clipsOf(flat.tracks[5]).map((clip) => clip.id)).toEqual(["c_a", "c_b"]);
    // Only the copies are silenced: the plates keep their sound, the nested one muted by its own track.
    expect(clipsOf(flat.tracks[0]).map((clip) => clip.audio)).toEqual([{ gain: -3 }, { gain: -3 }, { gain: -3, muted: true }]);
  });
});
