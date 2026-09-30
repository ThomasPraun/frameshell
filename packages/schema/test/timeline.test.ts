import { describe, expect, it } from "vitest";
import { createTimeline, parseTimeline } from "../src/index.js";

/** SPEC §5.3 example, verbatim apart from elided fields. */
const specExample = {
  $schema: "https://frameshell.dev/schema/v1/timeline.json",
  schemaVersion: 1,
  id: "main",
  revision: 184,
  tracks: [
    {
      id: "v1",
      kind: "video",
      name: "Camera",
      clips: [
        {
          id: "c_0001",
          type: "media",
          asset: "assets/raw-01.mp4",
          start: 0.0,
          in: 3.2,
          out: 15.733,
          speed: 1.15,
          audio: { gain: 0, muted: false },
        },
        { id: "c_0002", type: "media", asset: "assets/raw-01.mp4", start: 10.898, in: 17.1, out: 42.567, speed: 1.15 },
      ],
    },
    {
      id: "v2",
      kind: "video",
      name: "Overlays",
      clips: [
        {
          id: "c_0100",
          type: "hyperframes",
          source: "compositions/hyperframes/intro/index.html",
          start: 0.0,
          duration: 8.0,
          props: { title: "No vendas agentes de IA" },
          transform: { x: 0, y: 0, scale: 1, opacity: 1 },
          scriptRef: "scripts/script.md#intro",
        },
        { id: "c_0101", type: "timeline", source: "timelines/intro.json", start: 60.0 },
      ],
    },
    {
      id: "a1",
      kind: "audio",
      name: "Music",
      clips: [{ id: "c_0200", type: "media", asset: "assets/music.wav", start: 0.0, in: 0.0, out: 30.0, audio: { gain: -18 } }],
    },
    { id: "s1", kind: "subtitles", name: "Subtitles", follows: "v1", style: { preset: "big-keyword", position: "bottom" } },
  ],
};

const withTracks = (tracks: unknown[]) => ({ ...createTimeline("main"), tracks });
const errorOf = (input: unknown) => {
  const result = parseTimeline(input);
  return result.ok ? null : result.error;
};

describe("timeline file", () => {
  it("scaffolds an empty timeline at revision 0 that validates", () => {
    const timeline = createTimeline("main");
    expect(timeline).toMatchObject({ schemaVersion: 1, id: "main", revision: 0, tracks: [] });
    expect(parseTimeline(timeline).ok).toBe(true);
  });

  it("rejects a negative revision", () => {
    expect(errorOf({ ...createTimeline("main"), revision: -1 })).toMatch(/revision/);
  });

  it("accepts the SPEC §5.3 example: media, adapter and nested timeline clips, audio and subtitle tracks", () => {
    const result = parseTimeline(specExample);
    expect(result.ok ? null : result.error).toBeNull();
  });

  it("names the offending clip field instead of a bare union error", () => {
    const error = errorOf(
      withTracks([{ id: "v1", kind: "video", clips: [{ id: "c_1", type: "media", asset: "a.mp4", start: 0, in: 0, out: 1, speed: 0 }] }]),
    );
    expect(error).toMatch(/tracks\.0\.clips\.0\.speed/);
  });

  it("rejects a media clip whose out is not after in", () => {
    const error = errorOf(
      withTracks([{ id: "v1", kind: "video", clips: [{ id: "c_1", type: "media", asset: "a.mp4", start: 0, in: 2, out: 1 }] }]),
    );
    expect(error).toMatch(/clips\.0\.out.*after `in`/);
  });

  it("rejects duplicate ids across tracks and clips", () => {
    const clip = { id: "c_1", type: "media", asset: "a.mp4", start: 0, in: 0, out: 1 };
    const error = errorOf(
      withTracks([
        { id: "v1", kind: "video", clips: [clip] },
        { id: "a1", kind: "audio", clips: [{ ...clip, start: 5 }] },
      ]),
    );
    expect(error).toMatch(/tracks\.1\.clips\.0\.id: duplicate id "c_1"/);
  });

  it("requires subtitle tracks to follow an existing video or audio track", () => {
    expect(errorOf(withTracks([{ id: "s1", kind: "subtitles", follows: "v9" }]))).toMatch(/tracks\.0\.follows/);
    expect(errorOf(withTracks([{ id: "s1", kind: "subtitles", follows: "s1" }]))).toMatch(/tracks\.0\.follows/);
  });

  it("rejects clips on subtitle tracks and core type names used as adapter types", () => {
    expect(errorOf(withTracks([{ id: "v1", kind: "video", clips: [] }, { id: "s1", kind: "subtitles", follows: "v1", clips: [] }]))).toMatch(
      /clips/,
    );
    expect(
      errorOf(withTracks([{ id: "v1", kind: "video", clips: [{ id: "c_1", type: "timeline", start: 0, duration: 1, props: {} }] }])),
    ).toMatch(/props|source/);
  });

  it("rejects an adapter clip without duration and a transform with opacity above 1", () => {
    expect(errorOf(withTracks([{ id: "v1", kind: "video", clips: [{ id: "c_1", type: "hyperframes", start: 0 }] }]))).toMatch(
      /clips\.0\.duration/,
    );
    expect(
      errorOf(
        withTracks([
          { id: "v1", kind: "video", clips: [{ id: "c_1", type: "hyperframes", start: 0, duration: 1, transform: { opacity: 2 } }] },
        ]),
      ),
    ).toMatch(/transform\.opacity/);
  });
});
