import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { EDGE_FADE_SAMPLES } from "../src/renderer/src/preview/mixer.js";
import { compileProgram, firstAudioDifference, firstVideoDifference, programAt } from "../src/renderer/src/preview/program.js";

// Seam under test: what the preview plays, compiled from `timeline.show` plus `asset.list` (same rules as export).

/** No transform: centered, fitted, opaque. */
const IDENTITY = { x: 0, y: 0, scale: 1, opacity: 1 };
const HD = { width: 1920, height: 1080 };

type Track = TimelineView["tracks"][number];

function view(tracks: Track[]): TimelineView {
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: 30, duration: null, tracks, problems: [] };
}

function asset(path: string, overrides: Partial<AssetInfo> = {}): AssetInfo {
  const key = path.replace(/\W/g, "");
  return {
    path,
    hash: `sha256:${key}`,
    state: "ready",
    error: null,
    media: {
      duration: 600,
      format: "mov,mp4",
      video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false },
      audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    },
    proxy: `.frameshell/proxies/${key}.mp4`,
    sidecar: { path: `.frameshell/proxies/${key}.pcm`, format: "s16le", sampleRate: 48000, channels: 1 },
    waveform: null,
    thumbnails: null,
    ...overrides,
  };
}

const assets = (...list: AssetInfo[]) => new Map(list.map((a) => [a.path, a]));

const clip = (id: string, start: number, inS: number, out: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "media",
  asset: "assets/a.mp4",
  start,
  in: inS,
  out,
  end: start + (out - inS),
  ...extra,
});

describe("compileProgram", () => {
  it("plays the first video track's media clips from their proxies, frame-exact, with black gaps", () => {
    const program = compileProgram(
      view([{ id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 10, 12), clip("c2", 3, 20, 21.5)] }]),
      assets(asset("assets/a.mp4")),
    );
    expect(program.fps).toBe(30);
    expect(program.frames).toBe(135);
    expect(program.layers).toEqual([
      [
        { kind: "media", clip: "c1", start: 0, end: 60, proxy: ".frameshell/proxies/assetsamp4.mp4", in: 300, speed: 1, size: HD, placement: IDENTITY },
        { kind: "media", clip: "c2", start: 90, end: 135, proxy: ".frameshell/proxies/assetsamp4.mp4", in: 600, speed: 1, size: HD, placement: IDENTITY },
      ],
    ]);
  });

  it("mixes the sound of every unmuted media clip on every track from PCM sidecars, in program samples", () => {
    const program = compileProgram(
      view([
        {
          id: "v1",
          kind: "video",
          name: null,
          follows: null,
          clips: [clip("c1", 0, 10, 12), clip("c2", 2, 20, 21, { audio: { muted: true } })],
        },
        {
          id: "a1",
          kind: "audio",
          name: null,
          follows: null,
          clips: [{ ...clip("m1", 1, 0, 3, { audio: { gain: -6 } }), asset: "assets/music.wav" }],
        },
      ]),
      assets(asset("assets/a.mp4"), asset("assets/music.wav", { proxy: null, sidecar: { path: ".frameshell/proxies/music.pcm", format: "s16le", sampleRate: 48000, channels: 2 } })),
    );
    expect(program.sampleRate).toBe(48000);
    expect(program.audio).toEqual([
      { clip: "c1", start: 0, end: 96000, sidecar: ".frameshell/proxies/assetsamp4.pcm", channels: 1, in: 480000, speed: 1, gain: 1 },
      { clip: "m1", start: 48000, end: 192000, sidecar: ".frameshell/proxies/music.pcm", channels: 2, in: 0, speed: 1, gain: expect.closeTo(0.501187, 5) },
    ]);
  });

  it("maps sped-up clips: the timeline length shrinks, the source advances by `speed` per frame", () => {
    const program = compileProgram(
      view([{ id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 10, 13, { speed: 1.5 })] }]),
      assets(asset("assets/a.mp4")),
    );
    expect(program.layers[0]![0]).toMatchObject({ start: 0, end: 60, in: 300, speed: 1.5 });
    expect(program.audio[0]).toMatchObject({ start: 0, end: 96000, in: 480000, speed: 1.5 });
  });

  it("shows a placeholder for what it cannot play yet: generated clips, unreadable nested timelines, proxies still ingesting; stills draw as images", () => {
    const program = compileProgram(
      view([
        {
          id: "v1",
          kind: "video",
          name: null,
          follows: null,
          clips: [
            { id: "g1", type: "hyperframes", start: 0, end: 2, source: "compositions/hyperframes/intro/index.html", duration: 2 },
            { id: "n1", type: "timeline", start: 2, end: 4, source: "timelines/intro.json" },
            { ...clip("s1", 4, 0, 1), asset: "assets/logo.png" },
            { ...clip("p1", 5, 0, 1), asset: "assets/new.mp4" },
          ],
        },
      ]),
      assets(
        asset("assets/logo.png", { proxy: null, sidecar: null, media: { duration: null, format: "png_pipe", video: { codec: "png", width: 10, height: 10, fps: null, vfr: false, still: true }, audio: null } }),
        asset("assets/new.mp4", { state: "processing", proxy: null, sidecar: null }),
      ),
    );
    expect(program.layers[0]!.map(({ kind, clip, start, end, ...rest }) => ({ kind, clip, start, end, reason: "reason" in rest ? rest.reason : null }))).toEqual([
      { kind: "placeholder", clip: "g1", start: 0, end: 60, reason: "generated" },
      { kind: "placeholder", clip: "n1", start: 60, end: 120, reason: "timeline" },
      { kind: "still", clip: "s1", start: 120, end: 150, reason: null },
      { kind: "placeholder", clip: "p1", start: 150, end: 180, reason: "ingest" },
    ]);
    expect(program.layers[0]![2]).toMatchObject({ image: "assets/logo.png", version: "sha256:assetslogopng", size: { width: 10, height: 10 } });
    expect(program.audio).toEqual([]);
  });

  it("stacks every video track as a layer, bottom first, each clip with its placement (#17)", () => {
    const program = compileProgram(
      view([
        { id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 1)] },
        { id: "a1", kind: "audio", name: null, follows: null, clips: [] },
        { id: "v2", kind: "video", name: null, follows: null, clips: [clip("c2", 0, 5, 6, { transform: { x: 100, scale: 0.5, opacity: 0.4 } })] },
      ]),
      assets(asset("assets/a.mp4")),
      { resolution: { width: 1280, height: 720 } },
    );
    expect(program.resolution).toEqual({ width: 1280, height: 720 });
    expect(program.layers.map((layer) => layer.map((span) => span.clip))).toEqual([["c1"], ["c2"]]);
    expect(programAt(program, 10, 1)).toMatchObject({ clip: "c2", placement: { x: 100, y: 0, scale: 0.5, opacity: 0.4 } });
    expect(program.audio.map((span) => span.clip)).toEqual(["c1", "c2"]);
  });

  it("plays nested timelines flattened, as export does: their clips in the nested clip's slot and layers above", () => {
    const intro: TimelineView = {
      ...view([
        { id: "v1", kind: "video", name: null, follows: null, clips: [clip("cam", 0, 10, 14)] },
        { id: "v2", kind: "video", name: null, follows: null, clips: [clip("logo", 1, 0, 2, { transform: { scale: 0.5 } })] },
      ]),
      timeline: "intro",
    };
    const main = view([
      {
        id: "v1",
        kind: "video",
        name: null,
        follows: null,
        clips: [clip("c1", 0, 0, 1), { id: "n1", type: "timeline", source: "timelines/intro.json", start: 1, end: 4, in: 1 }],
      },
    ]);
    const program = compileProgram(main, assets(asset("assets/a.mp4")), { nested: new Map([["timelines/intro.json", intro]]) });
    // Intro seconds 1 to 4 play from 1 s: camera source 11 to 14, the logo's 2 s from 1 s.
    expect(program.layers[0]!.map(({ clip, start, end }) => [clip, start, end])).toEqual([
      ["c1", 0, 30],
      ["n1/cam", 30, 120],
    ]);
    expect(program.layers[0]![1]).toMatchObject({ in: 330 });
    expect(program.layers[1]!.map(({ clip, start, end }) => [clip, start, end])).toEqual([["n1/logo", 30, 90]]);
    expect(program.audio.map((span) => span.clip)).toEqual(["c1", "n1/cam", "n1/logo"]);
  });

  it("lets the later of two overlapping clips (hand-edited file) win from its start, as export does", () => {
    const program = compileProgram(
      view([{ id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 2), clip("c2", 1, 5, 6)] }]),
      assets(asset("assets/a.mp4")),
    );
    expect(program.layers[0]!.map(({ clip, start, end }) => [clip, start, end])).toEqual([
      ["c1", 0, 30],
      ["c2", 30, 60],
    ]);
  });

  it("is empty for an empty timeline", () => {
    const program = compileProgram(view([]), assets());
    expect(program).toMatchObject({ frames: 0, layers: [], audio: [] });
  });
});

describe("programAt", () => {
  it("finds the picture span at a program frame; null in gaps and past the end", () => {
    const program = compileProgram(
      view([{ id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 10, 12), clip("c2", 3, 20, 21.5)] }]),
      assets(asset("assets/a.mp4")),
    );
    expect(programAt(program, 0)?.clip).toBe("c1");
    expect(programAt(program, 59)?.clip).toBe("c1");
    expect(programAt(program, 60)).toBeNull();
    expect(programAt(program, 90)?.clip).toBe("c2");
    expect(programAt(program, 135)).toBeNull();
  });
});

describe("program differences (live timeline changes)", () => {
  const v = (clips: Track["clips"]) =>
    compileProgram(view([{ id: "v1", kind: "video", name: null, follows: null, clips }]), assets(asset("assets/a.mp4")));

  it("finds no picture or sound difference when nothing that plays changed", () => {
    const a = v([clip("c1", 0, 10, 12), clip("c2", 2, 20, 22)]);
    const b = v([clip("c1", 0, 10, 12), clip("c2", 2, 20, 22)]);
    expect(firstVideoDifference(a, b, 0)).toBe(Infinity);
    expect(firstAudioDifference(a, b, 0)).toBe(Infinity);
  });

  it("finds the frame where a ripple cut changes the picture, never before `from`", () => {
    const before = v([clip("c1", 0, 10, 12), clip("c2", 2, 20, 22)]);
    const after = v([clip("c1", 0, 10, 11), clip("c2", 1, 20, 22)]);
    expect(firstVideoDifference(before, after, 0)).toBe(30);
    expect(firstVideoDifference(before, after, 45)).toBe(45);
    expect(firstAudioDifference(before, after, 0)).toBe(48_000 - EDGE_FADE_SAMPLES);
    expect(firstAudioDifference(before, after, 60_000)).toBe(60_000);
  });

  it("sees an end trimmed later only from the new end (sound: from its fade-out)", () => {
    const before = v([clip("c1", 0, 10, 20)]);
    const after = v([clip("c1", 0, 10, 15)]);
    expect(firstVideoDifference(before, after, 0)).toBe(150);
    expect(firstAudioDifference(before, after, 0)).toBe(5 * 48_000 - EDGE_FADE_SAMPLES);
  });

  it("sees a placement change as no new picture: it is a redraw, not a new decode", () => {
    const before = v([clip("c1", 0, 10, 12)]);
    const after = v([clip("c1", 0, 10, 12, { transform: { scale: 0.5 } })]);
    expect(firstVideoDifference(before, after, 0)).toBe(Infinity);
  });

  it("compares one layer at a time; a layer one side lacks is empty", () => {
    const two = (clips: Track["clips"]) =>
      compileProgram(
        view([
          { id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 10, 12)] },
          { id: "v2", kind: "video", name: null, follows: null, clips },
        ]),
        assets(asset("assets/a.mp4")),
      );
    const one = v([clip("c1", 0, 10, 12)]);
    const overlay = two([clip("o1", 1, 0, 1)]);
    expect(firstVideoDifference(one, overlay, 0, 0)).toBe(Infinity);
    expect(firstVideoDifference(one, overlay, 0, 1)).toBe(30);
    expect(firstVideoDifference(overlay, two([clip("o1", 1, 5, 6)]), 0, 1)).toBe(30);
  });

  it("sees a clip added later in the program only from its start", () => {
    const before = v([clip("c1", 0, 10, 12)]);
    const after = v([clip("c1", 0, 10, 12), clip("c2", 5, 20, 22)]);
    expect(firstVideoDifference(before, after, 0)).toBe(150);
    expect(firstAudioDifference(before, after, 0)).toBe(240_000);
  });
});
