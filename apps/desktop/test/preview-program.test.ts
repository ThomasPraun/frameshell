import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { EDGE_FADE_SAMPLES } from "../src/renderer/src/preview/mixer.js";
import { compileProgram, firstAudioDifference, firstVideoDifference, programAt } from "../src/renderer/src/preview/program.js";

// Seam under test: what the preview plays, compiled from `timeline.show` plus `asset.list` (same rules as export v1).

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
    expect(program.video).toEqual([
      { kind: "media", clip: "c1", start: 0, end: 60, proxy: ".frameshell/proxies/assetsamp4.mp4", in: 300, speed: 1 },
      { kind: "media", clip: "c2", start: 90, end: 135, proxy: ".frameshell/proxies/assetsamp4.mp4", in: 600, speed: 1 },
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
    expect(program.video[0]).toMatchObject({ start: 0, end: 60, in: 300, speed: 1.5 });
    expect(program.audio[0]).toMatchObject({ start: 0, end: 96000, in: 480000, speed: 1.5 });
  });

  it("shows a placeholder for what it cannot play yet: generated and nested clips, stills, proxies still ingesting", () => {
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
    expect(program.video.map(({ kind, clip, start, end, ...rest }) => ({ kind, clip, start, end, reason: "reason" in rest ? rest.reason : null }))).toEqual([
      { kind: "placeholder", clip: "g1", start: 0, end: 60, reason: "generated" },
      { kind: "placeholder", clip: "n1", start: 60, end: 120, reason: "timeline" },
      { kind: "placeholder", clip: "s1", start: 120, end: 150, reason: "still" },
      { kind: "placeholder", clip: "p1", start: 150, end: 180, reason: "ingest" },
    ]);
    expect(program.audio).toEqual([]);
  });

  it("shows only the base video track: upper tracks are overlays, not previewed yet (#17)", () => {
    const program = compileProgram(
      view([
        { id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 1)] },
        { id: "v2", kind: "video", name: null, follows: null, clips: [clip("c2", 0, 5, 6)] },
      ]),
      assets(asset("assets/a.mp4")),
    );
    expect(program.video.map((span) => span.clip)).toEqual(["c1"]);
    expect(program.audio.map((span) => span.clip)).toEqual(["c1", "c2"]);
  });

  it("lets the later of two overlapping clips (hand-edited file) win from its start, as export does", () => {
    const program = compileProgram(
      view([{ id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 2), clip("c2", 1, 5, 6)] }]),
      assets(asset("assets/a.mp4")),
    );
    expect(program.video.map(({ clip, start, end }) => [clip, start, end])).toEqual([
      ["c1", 0, 30],
      ["c2", 30, 60],
    ]);
  });

  it("is empty for an empty timeline", () => {
    const program = compileProgram(view([]), assets());
    expect(program).toMatchObject({ frames: 0, video: [], audio: [] });
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

  it("sees a clip added later in the program only from its start", () => {
    const before = v([clip("c1", 0, 10, 12)]);
    const after = v([clip("c1", 0, 10, 12), clip("c2", 5, 20, 22)]);
    expect(firstVideoDifference(before, after, 0)).toBe(150);
    expect(firstAudioDifference(before, after, 0)).toBe(240_000);
  });
});
