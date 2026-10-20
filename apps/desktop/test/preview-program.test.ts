import type { AssetInfo, ClipRenderInfo, TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { EDGE_FADE_SAMPLES } from "../src/renderer/src/preview/mixer.js";
import {
  type AngleSpan,
  type VideoSpan,
  angleLayer,
  compileProgram,
  firstAudioDifference,
  firstVideoDifference,
  placeholdersAt,
  programAt,
} from "../src/renderer/src/preview/program.js";

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

  it("shows a placeholder for what it cannot play yet: unreadable nested timelines, proxies still ingesting; stills draw as images", () => {
    const program = compileProgram(
      view([
        {
          id: "v1",
          kind: "video",
          name: null,
          follows: null,
          clips: [
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
      { kind: "placeholder", clip: "n1", start: 60, end: 120, reason: "timeline" },
      { kind: "still", clip: "s1", start: 120, end: 150, reason: null },
      { kind: "placeholder", clip: "p1", start: 150, end: 180, reason: "ingest" },
    ]);
    expect(program.layers[0]![1]).toMatchObject({ image: "assets/logo.png", version: "sha256:assetslogopng", size: { width: 10, height: 10 } });
    expect(program.audio).toEqual([]);
  });

  it("plays generated clips from their cached renders on their own layer, with render state until ready (SPEC §6.5)", () => {
    const generated = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) => ({
      id,
      type: "hyperframes",
      source: `compositions/hyperframes/${id}/index.html`,
      start,
      duration,
      end: start + duration,
      ...extra,
    });
    const ready: ClipRenderInfo = {
      clip: "g2",
      track: "v2",
      type: "hyperframes",
      source: null,
      state: "ready",
      key: "k2",
      file: ".frameshell/cache/clips/k2.webm",
      hasAlpha: true,
      width: 1920,
      height: 1080,
      duration: 3,
      job: null,
      progress: 1,
      error: null,
    };
    const rendering: ClipRenderInfo = { ...ready, clip: "g1", track: "v1", state: "rendering", key: "k1", file: null, hasAlpha: null, width: null, height: null, job: "j_c1", progress: 0.4 };
    const program = compileProgram(
      view([
        { id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 2), generated("g1", 2, 1)] },
        { id: "v2", kind: "video", name: null, follows: null, clips: [generated("g2", 0.5, 1, { in: 0.5, transform: { x: 40, scale: 0.5 } }), generated("g3", 1.5, 1)] },
      ]),
      assets(asset("assets/a.mp4")),
      {
        renders: new Map([
          ["g1", rendering],
          ["g2", ready],
        ]),
      },
    );
    expect(program.frames).toBe(90);
    expect(program.layers[0]![1]).toEqual({
      kind: "generated", clip: "g1", type: "hyperframes", start: 60, end: 90, in: 0,
      render: { state: "rendering", progress: 0.4, error: null, key: "k1" }, size: null, placement: IDENTITY,
    });
    expect(program.layers[1]).toEqual([
      {
        kind: "generated", clip: "g2", type: "hyperframes", start: 15, end: 45, in: 15,
        render: { state: "ready", file: ".frameshell/cache/clips/k2.webm" }, size: HD, placement: { ...IDENTITY, x: 40, scale: 0.5 },
      },
      { kind: "generated", clip: "g3", type: "hyperframes", start: 45, end: 75, in: 0, render: null, size: null, placement: IDENTITY },
    ]);
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

  it("sees a generated clip's render arriving or changing as a new picture from the clip's start", () => {
    const card = (start: number, extra: Record<string, unknown> = {}) => ({ id: "g1", type: "card", start, duration: 1, end: start + 1, ...extra });
    const render = (state: "ready" | "rendering", key = "k1"): ClipRenderInfo => ({
      clip: "g1", track: "v1", type: "card", source: null, state, key, file: state === "ready" ? `.frameshell/cache/clips/${key}.webm` : null,
      hasAlpha: state === "ready" ? true : null, width: 64, height: 36, duration: 1, job: null, progress: state === "ready" ? 1 : 0.5, error: null,
    });
    const at = (clips: Track["clips"], info: ClipRenderInfo) =>
      compileProgram(view([{ id: "v1", kind: "video", name: null, follows: null, clips }]), assets(), { renders: new Map([["g1", info]]) });
    const pending = at([card(2)], render("rendering"));
    const ready = at([card(2)], render("ready"));
    expect(firstVideoDifference(pending, ready, 0)).toBe(60);
    expect(firstVideoDifference(ready, at([card(2)], render("ready", "k2")), 0)).toBe(60);
    // Same render file and frames: nothing to decode again. Another `in` shows other frames.
    expect(firstVideoDifference(ready, at([card(2)], render("ready")), 0)).toBe(Infinity);
    expect(firstVideoDifference(ready, at([card(2, { in: 0.5 })], render("ready")), 0)).toBe(60);
  });

  it("sees a clip added later in the program only from its start", () => {
    const before = v([clip("c1", 0, 10, 12)]);
    const after = v([clip("c1", 0, 10, 12), clip("c2", 5, 20, 22)]);
    expect(firstVideoDifference(before, after, 0)).toBe(150);
    expect(firstAudioDifference(before, after, 0)).toBe(240_000);
  });
});

describe("compileProgram with a multicam program track", () => {
  const shot = (id: string, start: number, from: number, to: number, layout: string, angles: string[]) => ({
    id,
    type: "shot",
    start,
    in: from,
    out: to,
    end: start + to - from,
    shot: layout,
    angles,
  });
  const group = {
    id: "g_talk",
    angles: [
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
      { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 1.5, audio: { gain: -6 } },
      { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0.25 },
    ],
  };
  const programTrack = (clips: unknown[]): Track => ({ id: "t_p", kind: "program", name: null, follows: null, group: "g_talk", clips } as Track);
  const talk = (tracks: Track[]) => ({ ...view(tracks), groups: [group] });
  const angles = assets(asset("assets/ana.mp4"), asset("assets/ben.mp4"), asset("assets/eva.mp4"));
  const proxy = (name: string) => `.frameshell/proxies/assets${name}mp4.mp4`;
  const sidecar = (name: string) => `.frameshell/proxies/assets${name}mp4.pcm`;
  // Group clock = timeline time: solo Ana, two-up Ben | Ana, grid of three, solo Eva.
  const SHOTS = [
    shot("s1", 0, 0, 1, "solo", ["ana"]),
    shot("s2", 1, 1, 2, "two-up", ["ben", "ana"]),
    shot("s3", 2, 2, 3, "grid", ["ana", "ben", "eva"]),
    shot("s4", 3, 3, 4, "solo", ["eva"]),
  ];
  const brief = (spans: VideoSpan[]) =>
    spans.map((s) => (s.kind === "angle" ? `${s.clip}:${s.angle}@${s.start}-${s.end}<${s.in}` : s.kind === "placeholder" ? `${s.clip}:${s.reason}@${s.start}-${s.end}` : s.kind));

  it("gives a program track one layer per angle slot; an angle keeps its slot across shots, offsets map group time to source", () => {
    const program = compileProgram(talk([programTrack(SHOTS)]), angles);
    expect(program.frames).toBe(120);
    expect(program.layers.map(brief)).toEqual([
      ["s1:ana@0-30<0", "s2:ana@30-60<30", "s3:ana@60-90<60"],
      // Ben's file starts 1.5 s into the group: nothing of it before frame 45.
      ["s2:ben@45-60<0", "s3:ben@60-90<15"],
      // 1.75 s and 2.75 s of Eva's file: frames 52.5 and 82.5, rounded.
      ["s3:eva@60-90<53", "s4:eva@90-120<83"],
    ]);
    const first = program.layers[0]![0]!;
    expect(first).toMatchObject({ kind: "angle", proxy: proxy("ana"), speed: 1 });
  });

  it("lays each angle out in its shot's tile with shotLayers, at any frame size", () => {
    const program = compileProgram(talk([programTrack(SHOTS)]), angles);
    const ana = programAt(program, 45, 0) as AngleSpan;
    const ben = programAt(program, 45, 1) as AngleSpan;
    // Two-up Ben | Ana: Ana's slot is 0, her tile the right half. A 1920x1080 picture cut to a 480x540 tile.
    expect(angleLayer(ana, { width: 960, height: 540 })).toEqual({
      tile: { left: 480, top: 0, width: 480, height: 540 },
      crop: { left: 480, top: 0, width: 960, height: 1080 },
      backdrop: false,
      source: HD,
    });
    expect(angleLayer(ben, { width: 960, height: 540 })?.tile).toEqual({ left: 0, top: 0, width: 480, height: 540 });
    expect(angleLayer(programAt(program, 15, 0) as AngleSpan, HD)?.tile).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("cuts a reframed angle where its keys say at the frame shown, in a 9:16 frame as export does", () => {
    const keyed = { ...group, angles: group.angles.map((a) => (a.id === "ana" ? { ...a, reframe: [{ at: 4, x: 0.25, y: 0.5 }, { at: 6, x: 0.75, y: 0.5 }] } : a)) };
    // Timeline 0..4 plays group 4..8, so the cut moves during the first two seconds.
    const program = compileProgram({ ...view([programTrack([shot("s1", 0, 4, 8, "solo", ["ana"])])]), groups: [keyed] }, angles);
    const span = programAt(program, 0, 0) as AngleSpan;
    const tall = { width: 1080, height: 1920 };
    expect(angleLayer(span, tall, 0)?.crop).toEqual({ left: 176, top: 0, width: 608, height: 1080 });
    expect(angleLayer(span, tall, 1)?.crop.left).toBe(656);
    expect(angleLayer(span, tall, 3)?.crop.left).toBe(1136);
    // The project's own 16:9 frame does not cut a 16:9 picture: keys change nothing there.
    expect(angleLayer(span, HD, 1)?.crop).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("plays every angle's sound under every shot, sample-exact, one span per unbroken run", () => {
    const program = compileProgram(talk([programTrack(SHOTS)]), angles);
    expect(program.audio).toEqual([
      { clip: "s1/ana", start: 0, end: 192_000, sidecar: sidecar("ana"), channels: 1, in: 0, speed: 1, gain: 1 },
      // Eva's file starts at group 0.25 s; Ben's at 1.5 s, 6 dB down.
      { clip: "s1/eva", start: 12_000, end: 192_000, sidecar: sidecar("eva"), channels: 1, in: 0, speed: 1, gain: 1 },
      { clip: "s2/ben", start: 72_000, end: 192_000, sidecar: sidecar("ben"), channels: 1, in: 0, speed: 1, gain: 10 ** (-6 / 20) },
    ]);
  });

  it("places sub-frame offsets at the same exact samples as export", () => {
    // Mirrors packages/core/test/export-multicam.test.ts "multicam sound at exact samples".
    const room = { id: "g_talk", angles: [{ id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0.01 }, { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.025 }] };
    const program = compileProgram(
      { ...view([programTrack([shot("c_1", 0, 0.0105, 1.0105, "solo", ["ana"]), shot("c_2", 1, 1.0105, 2.0105, "solo", ["ben"])])]), groups: [room] },
      angles,
    );
    const spans = (name: string) => program.audio.filter((s) => s.sidecar === sidecar(name)).map((s) => [s.start, s.end, s.in]);
    expect(spans("ana")).toEqual([[0, 96_000, 24]]);
    expect(spans("ben")).toEqual([[696, 96_000, 0]]);
  });

  it("keeps exact samples for a program track nested in an audio track, as export does", () => {
    // Mirrors packages/core/test/export-multicam.test.ts "keeps exact samples for a program track nested in an audio track".
    const room = { id: "g_talk", angles: [{ id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0.01 }, { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.025 }] };
    const nested = { ...view([programTrack([shot("c_1", 0, 0.0105, 1.0105, "solo", ["ana"]), shot("c_2", 1, 1.0105, 2.0105, "solo", ["ben"])])]), timeline: "talk", groups: [room] };
    const main = view([{ id: "a1", kind: "audio", name: null, follows: null, clips: [{ id: "c_n", type: "timeline", source: "timelines/talk.json", start: 0.5, end: 2.5, in: 0, duration: 2 }] } as Track]);
    const program = compileProgram(main, angles, { nested: new Map([["timelines/talk.json", nested]]) });
    const spans = (name: string) => program.audio.filter((s) => s.sidecar === sidecar(name)).map((s) => [s.clip, s.start, s.end, s.in]);
    // One span per sound across the shot change, no edge fade; frames would round Ana's 24 and Ben's 696 away.
    expect(spans("ana")).toEqual([["c_n/c_1/ana", 24_000, 120_000, 24]]);
    expect(spans("ben")).toEqual([["c_n/c_1/ben", 24_696, 120_000, 0]]);
  });

  describe("nested program sound beside the host track's own clips (as export: export-multicam.test.ts)", () => {
    const room = { id: "g_talk", angles: [{ id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0.01 }, { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.025 }] };
    const nested = { ...view([programTrack([shot("c_1", 0, 0.0105, 1.0105, "solo", ["ana"]), shot("c_2", 1, 1.0105, 2.0105, "solo", ["ben"])])]), timeline: "talk", groups: [room] };
    /** Host a1: the nested talk (2 s) from 0.5 s, then Eva's own clip of 1 s from `own`. */
    const spans = (own: number, extra: Record<string, unknown> = {}) => {
      const host = { id: "c_n", type: "timeline", source: "timelines/talk.json", start: 0.5, end: 2.5, in: 0, ...extra };
      const main = view([{ id: "a1", kind: "audio", name: null, follows: null, clips: [host, clip("c_m", own, 0, 1, { asset: "assets/eva.mp4" })] } as Track]);
      const program = compileProgram(main, angles, { nested: new Map([["timelines/talk.json", nested]]) });
      return program.audio.map((s) => [s.clip, s.start, s.end, Math.round(20 * Math.log10(s.gain))]);
    };

    it("ends nested sound where a later own clip starts, which keeps its own start (the nested clip has no duration)", () => {
      expect(spans(2)).toEqual([
        ["c_n/c_1/ana", 24_000, 96_000, 0],
        ["c_n/c_1/ben", 24_696, 120_000, 0],
        ["c_m", 96_000, 144_000, 0],
      ]);
    });

    it("places an own clip right after the nested sound at its own start", () => {
      expect(spans(2.5, { duration: 2 })).toEqual([
        ["c_n/c_1/ana", 24_000, 120_000, 0],
        ["c_n/c_1/ben", 24_696, 120_000, 0],
        ["c_m", 120_000, 168_000, 0],
      ]);
    });

    it("puts the nested clip's gain and mute on its program sound", () => {
      expect(spans(2.5, { duration: 2, audio: { gain: -6 } }).map(([id, , , gain]) => [id, gain])).toEqual([
        ["c_n/c_1/ana", -6],
        ["c_n/c_1/ben", -6],
        ["c_m", 0],
      ]);
      expect(spans(2.5, { duration: 2, audio: { muted: true } }).map(([id]) => id)).toEqual(["c_m"]);
    });
  });

  it("splits an angle's sound where the group clock jumps (a ripple cut), and leaves muted angles out", () => {
    const muted = { ...group, angles: group.angles.map((a) => (a.id === "ben" ? { ...a, audio: { muted: true } } : a)) };
    const program = compileProgram(
      { ...view([programTrack([shot("s1", 0, 0, 1, "solo", ["ana"]), shot("s2", 1, 3, 4, "solo", ["ana"])])]), groups: [muted] },
      angles,
    );
    expect(program.audio.filter((s) => s.sidecar === sidecar("ana")).map((s) => [s.start, s.end, s.in])).toEqual([
      [0, 48_000, 0],
      [48_000, 96_000, 144_000],
    ]);
    expect(program.audio.some((s) => s.sidecar === sidecar("ben"))).toBe(false);
  });

  it("plays a mic's file once, with its own offset and gain, instead of the angles' own sound", () => {
    const miked = {
      ...group,
      angles: [
        { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "lav" },
        { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 1.5, mic: "lav" },
        { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0.25, mic: null },
      ],
      mics: [{ id: "lav", name: "Lav", asset: "assets/lav.wav", offset: 2, audio: { gain: -6 } }],
    };
    const program = compileProgram(
      { ...view([programTrack([shot("s1", 0, 0, 3, "solo", ["ana"]), shot("s2", 3, 3, 4, "solo", ["ben"])])]), groups: [miked] },
      assets(asset("assets/ana.mp4"), asset("assets/ben.mp4"), asset("assets/eva.mp4"), asset("assets/lav.wav", { proxy: null })),
    );
    // One unbroken span from the mic's start at group second 2 to the end of the program (4 s), across the shot change.
    expect(program.audio).toEqual([
      { clip: "s1/lav", start: 96_000, end: 192_000, sidecar: ".frameshell/proxies/assetslavwav.pcm", channels: 1, in: 0, speed: 1, gain: 10 ** (-6 / 20) },
    ]);
    // The pictures still come from the angles' files.
    expect(program.layers.map(brief)).toEqual([["s1:ana@0-90<0", "s2:ben@90-120<45"]]);
  });

  it("shows a placeholder for an angle still ingesting, in its slot only", () => {
    const ingesting = assets(asset("assets/ana.mp4"), asset("assets/ben.mp4", { state: "processing", proxy: null }), asset("assets/eva.mp4"));
    const program = compileProgram(talk([programTrack([SHOTS[1]!])]), ingesting);
    expect(program.layers.map(brief)).toEqual([["s2:ingest@30-60"], ["s2:ana@30-60<30"]]);
    // Ben's slot is layer 0, yet his slate covers only his tile: Ana's half still shows.
    const shown = placeholdersAt(program, 45);
    expect(shown.base).toBeNull();
    expect(shown.notes).toEqual([]);
    expect(shown.tiles.map(({ span, layer, tile }) => [span.angle?.id, layer, tile])).toEqual([["ben", 0, { left: 0, top: 0, width: 960, height: 1080 }]]);
  });

  it("stacks above the video tracks under it and does not restart an angle's decode at a layout change", () => {
    const base = { id: "v1", kind: "video", name: null, follows: null, clips: [clip("c1", 0, 0, 4, { asset: "assets/ana.mp4" })] } as Track;
    const before = compileProgram(talk([base, programTrack(SHOTS)]), angles);
    expect(before.layers).toHaveLength(4);
    expect(before.layers[0]![0]!.kind).toBe("media");
    // s2 becomes a grid of Ana and Ben: Ana's slot shows the same frames, Ben's too.
    const regrid = SHOTS.map((s) => (s.id === "s2" ? { ...s, shot: "grid", angles: ["ana", "ben"] } : s));
    const after = compileProgram(talk([base, programTrack(regrid)]), angles);
    expect(firstVideoDifference(before, after, 0, 1)).toBe(Infinity);
    expect(firstVideoDifference(before, after, 0, 2)).toBe(Infinity);
  });

  it("paints a pip inset above its screen: slots paint bottom first, so the screen takes the lower slot even when the inset was shown before", () => {
    const pips = [shot("s1", 0, 0, 1, "solo", ["ana"]), shot("s2", 1, 1, 2, "pip", ["eva", "ana"])];
    const program = compileProgram(talk([programTrack(pips)]), angles);
    expect(program.layers.map(brief)).toEqual([
      // Eva (the screen) swaps into slot 0 under Ana, who was there alone.
      ["s1:ana@0-30<0", "s2:eva@30-60<23"],
      ["s2:ana@30-60<30"],
    ]);
    const screen = programAt(program, 45, 0) as AngleSpan;
    const inset = programAt(program, 45, 1) as AngleSpan;
    // The screen fills the frame (bars where shapes differ) and the inset sits in the bottom-right corner over it.
    expect(angleLayer(screen, HD)!.tile).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(angleLayer(inset, HD)!.tile).toEqual({ left: 1402, top: 772, width: 480, height: 270 });
  });

  it("refuses shots of a nested clip with a transform (they would fill the frame), and still plays their sound", () => {
    const podcast: TimelineView = { ...view([programTrack([SHOTS[0]!])]), timeline: "podcast", path: "timelines/podcast.json", groups: [group] };
    const nest = (transform?: object) =>
      view([
        {
          id: "v1",
          kind: "video",
          name: null,
          follows: null,
          clips: [{ id: "n1", type: "timeline", source: "timelines/podcast.json", start: 0, duration: 1, end: 1, ...(transform ? { transform } : {}) }],
        },
      ]);
    const nested = new Map([["timelines/podcast.json", podcast]]);
    const moved = compileProgram(nest({ scale: 0.5 }), angles, { nested });
    expect(moved.layers.map(brief)).toEqual([[], ["n1/s1:multicam@0-30"]]);
    expect(moved.audio.map((s) => s.clip)).toEqual(["n1/s1/ana", "n1/s1/eva"]);
    const still = compileProgram(nest(), angles, { nested });
    expect(still.layers.map(brief)).toEqual([[], ["n1/s1:ana@0-30<0"]]);
  });
});
