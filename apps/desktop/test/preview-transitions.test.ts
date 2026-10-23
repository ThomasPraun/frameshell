import type { AssetInfo, ClipRenderInfo, TimelineView } from "@frameshell/protocol";
import { gainAt, placementAt, soundCurve } from "@frameshell/schema/composite";
import { describe, expect, it } from "vitest";
import { envelopeGain, renderRead } from "../src/renderer/src/preview/audio-plan.js";
import { decodeSteps, syncTable } from "../src/renderer/src/preview/decode-plan.js";
import { type AudioSpan, type PlacedSpan, type VideoSpan, compileProgram, firstAudioDifference, programAt, spanPlacement } from "../src/renderer/src/preview/program.js";

// Seam under test: transitions and keys in the preview program (ADR 0018 decisions 9 and 10), against the shared evaluator.

type Track = TimelineView["tracks"][number];

const view = (tracks: Track[]): TimelineView => ({ timeline: "main", path: "timelines/main.json", revision: 1, fps: 30, duration: null, tracks, problems: [] });

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
      audio: { codec: "aac", sampleRate: 48000, channels: 1 },
    },
    proxy: `.frameshell/proxies/${key}.mp4`,
    sidecar: { path: `.frameshell/proxies/${key}.pcm`, format: "s16le", sampleRate: 48000, channels: 1 },
    waveform: null,
    thumbnails: null,
    ...overrides,
  };
}

const assets = (...list: AssetInfo[]) => new Map(list.map((a) => [a.path, a]));
const A = assets(asset("assets/a.mp4"));

const clip = (id: string, start: number, inS: number, out: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "media",
  asset: "assets/a.mp4",
  start,
  in: inS,
  out,
  end: start + (out - inS) / ((extra.speed as number | undefined) ?? 1),
  ...extra,
});

const video = (id: string, clips: Track["clips"]): Track => ({ id, kind: "video", name: null, follows: null, clips });
const brief = (spans: VideoSpan[]) => spans.map((s) => `${s.clip}@${s.start}-${s.end}${"in" in s ? `<${s.in}` : ""}${"hold" in s && s.hold ? "!" : ""}`);
const opacityAt = (program: ReturnType<typeof compileProgram>, frame: number, layer: number) =>
  spanPlacement(programAt(program, frame, layer) as PlacedSpan, frame, program.fps).opacity;

describe("compileProgram with transitions", () => {
  it("plays a project without transitions or keys exactly as before: no extra layer, no motion, no envelope", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 23)])]), A);
    expect(program.layers).toHaveLength(1);
    expect(program.layers[0]!.every((span) => !("motion" in span))).toBe(true);
    expect(program.audio.every((span) => !("envelope" in span))).toBe(true);
    expect(program.audio.map((s) => [s.start, s.end])).toEqual([
      [0, 96_000],
      [96_000, 240_000],
    ]);
  });

  it("puts the incoming clip's first half on a second layer and plays the outgoing clip on into its handle", () => {
    // 1 s dissolve at 2 s: 15 frames each side.
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 23, { dissolve: 1 })])]), A);
    expect(program.layers.map(brief)).toEqual([
      ["c1@0-75<300", "c2@75-150<615"],
      ["c2@45-75<585"],
    ]);
    expect(program.frames).toBe(150);
  });

  it("draws the incoming clip over the outgoing one at w on the bottom track, an exact mix", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 23, { dissolve: 1 })])]), A);
    // Frame 60 = 2.0 s, the cut: halfway.
    expect(opacityAt(program, 60, 0)).toBe(1);
    expect(opacityAt(program, 60, 1)).toBeCloseTo(0.5, 9);
    expect(opacityAt(program, 45, 1)).toBeCloseTo(0, 9);
    expect(opacityAt(program, 54, 1)).toBeCloseTo(0.3, 9);
    expect(opacityAt(program, 75, 0)).toBe(1);
  });

  it("fades the outgoing clip out as the incoming one fades in on an upper track", () => {
    const program = compileProgram(
      view([video("v1", [clip("bg", 0, 0, 5)]), video("v2", [clip("c1", 0, 10, 12, { transform: { opacity: 0.8 } }), clip("c2", 2, 20, 23, { dissolve: 1 })])]),
      A,
    );
    expect(program.layers.map((layer) => layer.map((s) => s.clip))).toEqual([["bg"], ["c1", "c2"], ["c2"]]);
    expect(opacityAt(program, 54, 1)).toBeCloseTo(0.8 * 0.7, 9);
    expect(opacityAt(program, 54, 2)).toBeCloseTo(0.3, 9);
  });

  it("holds a render's first and last frame as the handles of a generated clip", () => {
    const ready: ClipRenderInfo = {
      clip: "g1", track: "v1", type: "hyperframes", source: "c.html", state: "ready", key: "k1", file: ".frameshell/cache/clips/k1.webm",
      hasAlpha: false, width: 1920, height: 1080, duration: 2, job: null, progress: 1, error: null,
    };
    const generated = (id: string, start: number, extra: Record<string, unknown> = {}) => ({ id, type: "hyperframes", source: "c.html", start, duration: 2, end: start + 2, ...extra });
    const program = compileProgram(view([video("v1", [generated("g1", 0), generated("g2", 2, { dissolve: 0.5 })])]), A, {
      renders: new Map([
        ["g1", ready],
        ["g2", { ...ready, clip: "g2", file: ".frameshell/cache/clips/k2.webm" }],
      ]),
    });
    // Half of 0.5 s is 7.5 frames, whole frames: 8 (0.2667 s).
    expect(program.layers.map(brief)).toEqual([
      ["g1@0-60<0", "g1@60-68<59!", "g2@68-120<8"],
      ["g2@52-60<0!", "g2@60-68<0"],
    ]);
  });

  it("decodes a held piece (speed 0) as one frame shown throughout", () => {
    const table = syncTable(Array.from({ length: 60 }, (_, i) => i % 15 === 0));
    const steps = [...decodeSteps({ start: 52, end: 60, in: 59, speed: 0 }, 52, table)];
    expect(steps.filter((s) => s.from < s.to).map((s) => [s.sample, s.from, s.to])).toEqual([[59, 52, 60]]);
  });

  it("splits a sped-up clip so its pieces show the frames the whole clip would", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 26, { speed: 2, dissolve: 1 })])]), A);
    const [, main] = program.layers[0]!;
    const [head] = program.layers[1]!;
    const table = syncTable(Array.from({ length: 20_000 }, (_, i) => i % 15 === 0));
    const whole = { start: 45, end: 150, in: 600 - 30, speed: 2 };
    const shown = (timing: { start: number; end: number; in: number; speed: number }) =>
      [...decodeSteps(timing, timing.start, table)].filter((s) => s.from < s.to).map((s) => [s.sample, s.from, s.to]);
    expect([...shown(head as typeof whole), ...shown(main as typeof whole)]).toEqual(shown(whole));
  });

  it("plays a dissolve with no handle as a dip: fades over the clips' own frames, no second layer", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 0, 2), clip("c2", 2, 0, 3, { dissolve: 1 })])]), A);
    expect(program.layers.map(brief)).toEqual([["c1@0-60<0", "c2@60-150<0"]]);
    expect(opacityAt(program, 52, 0)).toBeCloseTo(8 / 15, 9);
    expect(opacityAt(program, 66, 0)).toBeCloseTo(6 / 15, 9);
  });

  it("cuts into a clip still ingesting instead of dissolving its placeholder", () => {
    const pending = asset("assets/b.mp4", { state: "processing", proxy: null });
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 23, { asset: "assets/b.mp4", dissolve: 1 })])]), assets(asset("assets/a.mp4"), pending));
    expect(program.layers.map(brief)).toEqual([["c1@0-60<300", "c2@60-150"]]);
  });

  it("fades a picture in from black and out to black, linear", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 0, 4, { fadeIn: 1, fadeOut: 0.5 })])]), A);
    expect(opacityAt(program, 0, 0)).toBe(0);
    expect(opacityAt(program, 15, 0)).toBeCloseTo(0.5, 9);
    expect(opacityAt(program, 60, 0)).toBe(1);
    expect(opacityAt(program, 111, 0)).toBeCloseTo(0.6, 9);
  });

  it("evaluates picture keys per frame with placementAt, keys on the clip's own clock", () => {
    const keys = { scale: [{ at: 10, value: 1 }, { at: 12, value: 2, ease: "in-out" }], x: [{ at: 11, value: 100 }] };
    const c1 = clip("c1", 5, 10, 14, { keys });
    const program = compileProgram(view([video("v1", [c1])]), A);
    const span = programAt(program, 180, 0) as PlacedSpan;
    expect(span.motion?.keyed).toBeDefined();
    for (const frame of [150, 165, 180, 195, 210, 260]) {
      expect(spanPlacement(span, frame, 30)).toEqual(placementAt(c1 as never, frame / 30));
    }
  });
});

describe("audio envelopes", () => {
  it("crossfades the sound of a dissolve equal-power, the outgoing clip trimmed past its out into its handle", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 10, 12), clip("c2", 2, 20, 23, { dissolve: 1 })])]), A);
    const [a, b] = program.audio as [AudioSpan, AudioSpan];
    expect([a.start, a.end, a.in]).toEqual([0, 120_000, 480_000]);
    expect([b.start, b.end, b.in]).toEqual([72_000, 240_000, 936_000]);
    for (const sample of [72_000, 84_000, 96_000, 108_000, 119_999]) {
      const f = (sample / 48_000 - 1.5) / 1;
      expect(envelopeGain(b, sample)).toBeCloseTo(soundCurve(f), 9);
      expect(envelopeGain(a, sample)).toBeCloseTo(soundCurve(1 - f), 9);
    }
    // Equal power through the middle.
    expect(envelopeGain(a, 96_000) ** 2 + envelopeGain(b, 96_000) ** 2).toBeCloseTo(1, 9);
  });

  it("follows gainAt sample by sample, times the fades, on an audio track", () => {
    const keys = { gain: [{ at: 1, value: 0 }, { at: 2, value: -12, ease: "out" }, { at: 3, value: 6 }] };
    const c1 = clip("c1", 0.5, 0.5, 4, { keys, fadeIn: 0.5, audio: { gain: -40 } });
    const program = compileProgram(view([{ id: "a1", kind: "audio", name: null, follows: null, clips: [c1] }]), A);
    const [span] = program.audio as [AudioSpan];
    for (let sample = span.start; sample < span.end; sample += 997) {
      const t = sample / 48_000;
      const fade = soundCurve((t - 0.5) / 0.5);
      expect(envelopeGain(span, sample)).toBeCloseTo(10 ** (gainAt(c1 as never, t) / 20) * fade, 9);
    }
  });

  it("applies the envelope to each rendered sample", () => {
    const program = compileProgram(view([video("v1", [clip("c1", 0, 0, 2, { fadeOut: 1 })])]), A);
    const [span] = program.audio as [AudioSpan];
    const pcm = new Int16Array(96_000).fill(16_384);
    const out = renderRead({ span, from: 60_000, to: 60_010 }, pcm, 0);
    expect(out[0]).toBeCloseTo(0.5 * soundCurve((2 - 60_000 / 48_000) / 1), 6);
    expect(out[9]).toBeCloseTo(0.5 * envelopeGain(span, 60_009), 6);
  });

  it("finds a changed envelope as a difference from the span's start", () => {
    const before = compileProgram(view([video("v1", [clip("c1", 0, 0, 4, { fadeIn: 1 })])]), A);
    const after = compileProgram(view([video("v1", [clip("c1", 0, 0, 4, { fadeIn: 2 })])]), A);
    expect(firstAudioDifference(before, after, 0)).toBe(0);
    expect(firstAudioDifference(before, before, 0)).toBe(Infinity);
  });
});
