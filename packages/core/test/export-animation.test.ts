import { describe, expect, it } from "vitest";
import {
  type Clip,
  type ClipKey,
  type MediaClip,
  type Timeline,
  clipTime,
  dissolveProgress,
  dissolveWeights,
  edgeTransitions,
  fadeWeight,
  flattenTimeline,
  gainAt,
  hostFades,
  keyedValueAt,
  layerRect,
  placementAt,
} from "@frameshell/schema";
import { BUILTIN_PRESETS, type ExportSource, compileRender } from "../src/index.js";
import { keyExpression } from "../src/export/animation.js";

// Parity of the export's ffmpeg expressions and ramps with the schema evaluator (ADR 0018 decision 9): every
// expression the compiler writes is evaluated here numerically and sampled against `composite.ts`.

/** Evaluate the ffmpeg expression subset the compiler emits: numbers, variables, + - * /, if, lt, floor, max, min, pow, sin. */
function evaluate(expression: string, variables: Record<string, number>): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[-+*/(),]/g)!;
  expect(tokens.join("")).toBe(expression.replace(/\s/g, ""));
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++]!;
    if (expected !== undefined) expect(token).toBe(expected);
    return token;
  };
  const functions: Record<string, (...args: number[]) => number> = {
    if: (c, a, b) => (c !== 0 ? a! : b!),
    lt: (a, b) => (a! < b! ? 1 : 0),
    floor: (a) => Math.floor(a!),
    max: (a, b) => Math.max(a!, b!),
    pow: (a, b) => a! ** b!,
    sin: (a) => Math.sin(a!),
    min: (a, b) => Math.min(a!, b!),
  };
  const primary = (): number => {
    const token = take();
    if (token === "(") {
      const value = sum();
      take(")");
      return value;
    }
    if (token === "-") return -primary();
    if (/^\d/.test(token)) return Number(token);
    if (peek() === "(") {
      take("(");
      const args = [sum()];
      while (peek() === ",") {
        take(",");
        args.push(sum());
      }
      take(")");
      return functions[token]!(...args);
    }
    expect(variables).toHaveProperty(token);
    return variables[token]!;
  };
  const product = (): number => {
    let value = primary();
    while (peek() === "*" || peek() === "/") value = take() === "*" ? value * primary() : value / primary();
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") value = take() === "+" ? value + product() : value - product();
    return value;
  };
  const value = sum();
  expect(at).toBe(tokens.length);
  return value;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const EASES = [undefined, "linear", "in", "out", "in-out"] as const;

describe("export expression parity", () => {
  it("keyExpression equals keyedValueAt at every sampled time, over any range it is cut to", () => {
    const next = random(7);
    for (let trial = 0; trial < 200; trial++) {
      const keys: ClipKey[] = [];
      let at = 2 + next() * 2;
      for (let k = 0, count = 1 + Math.floor(next() * 5); k < count; k++) {
        const ease = EASES[Math.floor(next() * EASES.length)];
        keys.push({ at: Math.round(at * 1000) / 1000, value: Math.round((next() * 200 - 100) * 100) / 100, ...(ease ? { ease } : {}) });
        at += 0.1 + next() * 2;
      }
      const speed = [1, 0.5, 1.25][trial % 3]!;
      const clip: MediaClip = { id: "c", type: "media", asset: "a.mp4", start: 10, in: 2, out: 14, speed, keys: { x: keys } };
      const from = 10 + next() * 8;
      const to = from + next() * 6;
      const expression = keyExpression(clip, keys, "t", from, to);
      for (let i = 0; i <= 40; i++) {
        const t = from + ((to - from) * i) / 40;
        const expected = keyedValueAt(keys, clipTime(clip, t))!;
        expect(evaluate(expression, { t }), `trial ${trial} t ${t}: ${expression}`).toBeCloseTo(expected, 4);
      }
    }
  });

  const sources = new Map<string, ExportSource>([
    ["assets/talk.mp4", { path: "/p/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 30 }],
    ["assets/logo.png", { path: "/p/logo.png", video: { codec: "png", still: true, width: 500, height: 300 }, audio: false }],
    ["assets/music.wav", { path: "/p/music.wav", video: null, audio: true, duration: 60 }],
  ]);
  const preset = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
  const resolution = { width: 1280, height: 720 };
  const logo: Clip = {
    id: "logo",
    type: "media",
    asset: "assets/logo.png",
    start: 1,
    in: 0,
    out: 3,
    transform: { y: 40, opacity: 0.8 },
    fadeIn: 0.5,
    keys: {
      x: [
        { at: 0.5, value: -300, ease: "in-out" },
        { at: 2, value: 250, ease: "out" },
        { at: 2.6, value: 0 },
      ],
      scale: [
        { at: 0, value: 0.3, ease: "in" },
        { at: 1.7, value: 0.9 },
      ],
    },
  };
  const music: Clip = {
    id: "music",
    type: "media",
    asset: "assets/music.wav",
    start: 0,
    in: 5,
    out: 9,
    fadeOut: 1,
    keys: {
      gain: [
        { at: 5.5, value: -30, ease: "in-out" },
        { at: 7, value: -6, ease: "in" },
        { at: 8, value: -12 },
      ],
    },
  };
  const timeline: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "a", type: "media", asset: "assets/talk.mp4", start: 0, in: 3, out: 5, fadeIn: 0.3 },
          { id: "b", type: "media", asset: "assets/talk.mp4", start: 2, in: 10, out: 12, dissolve: 0.6, fadeOut: 0.4 },
        ],
      },
      {
        id: "v2",
        kind: "video",
        clips: [
          { id: "u1", type: "media", asset: "assets/logo.png", start: 0, in: 0, out: 1, transform: { scale: 0.5, opacity: 0.6 } },
          logo,
        ],
      },
      { id: "a1", kind: "audio", clips: [music] },
    ],
  };
  // Logo dissolves from u1 too (stills have unlimited handles).
  (timeline.tracks[1] as { clips: Clip[] }).clips[1] = { ...logo, dissolve: 0.4 };
  const fps = 30;
  // Segments of 0.7 s cut inside every ramp and key span.
  const plan = compileRender({ timeline, fps, preset, loudness: -17, sources, resolution, segmentSeconds: 0.7 });
  const filters = plan.segments.map((segment) => ({ segment, text: plan.files[segment.args[segment.args.indexOf("-/filter_complex") + 1]!]! }));

  it("writes keyed scale and overlay position whose values are layerRect(placementAt) on every frame", () => {
    const keyed = (timeline.tracks[1] as { clips: Clip[] }).clips[1]!;
    let checked = 0;
    for (const { segment, text } of filters) {
      const scale = /scale=w='([^']+)':h='([^']+)':eval=frame/.exec(text);
      const overlay = /overlay=x='([^']+)':y='([^']+)':eval=frame/.exec(text);
      const from = Math.round(segment.from * fps);
      const to = Math.round(segment.to * fps);
      const start = Math.max(from, Math.round(keyed.start * fps) - 6);
      const end = Math.min(to, Math.round((keyed.start + 3) * fps));
      if (end <= start) continue;
      expect(scale && overlay, `segment ${segment.file}`).toBeTruthy();
      for (let frame = start; frame < end; frame++) {
        const t = frame / fps;
        const expected = layerRect({ width: 500, height: 300 }, preset.video, resolution, placementAt(keyed, t));
        const width = evaluate(scale![1]!, { t });
        const height = evaluate(scale![2]!, { t });
        const local = t - segment.from;
        const vars = { t: local, overlay_w: width, overlay_h: height };
        expect([width, height, evaluate(overlay![1]!, vars), evaluate(overlay![2]!, vars)], `frame ${frame}`).toEqual([
          expected.width,
          expected.height,
          expected.left,
          expected.top,
        ]);
        checked++;
      }
    }
    expect(checked).toBe(96);
  });

  it("writes picture ramps whose product is fadeWeight times the dissolve weight on every frame", () => {
    const edges = edgeTransitions((timeline.tracks[0] as { clips: Clip[] }).clips, { fps, sourceDuration: () => 30 });
    const upper = edgeTransitions((timeline.tracks[1] as { clips: Clip[] }).clips, { fps, sourceDuration: () => Number.POSITIVE_INFINITY });
    /** `fade` filter factor at timeline second t, as vf_fade computes it. */
    const fade = (type: string, st: number, d: number, t: number) => {
      const f = Math.min(1, Math.max(0, (t - st) / d));
      return type === "in" ? f : 1 - f;
    };
    const product = (chain: string, t: number) =>
      [...chain.matchAll(/fade=t=(in|out)(?::alpha=1)?:st=([\d.]+):d=([\d.]+)/g)].reduce((p, m) => p * fade(m[1]!, Number(m[2]), Number(m[3]), t), 1);
    let checked = 0;
    for (const { segment, text } of filters) {
      const lines = text.split(";\n");
      const from = Math.round(segment.from * fps);
      const to = Math.round(segment.to * fps);
      for (let frame = from; frame < to; frame++) {
        const t = frame / fps;
        // Base: b's head is a layer over a's tail (from 1.7 s to 2.3 s); the concatenated clips fade to black.
        const head = lines.find((line) => line.includes("alpha=1") && line.includes("st=1.7:d=0.6"));
        const bEdges = edges.get("b")!;
        if (frame >= 51 && frame < 69) {
          const w = dissolveWeights(dissolveProgress(2, bEdges.dissolve, t), "bottom").incoming;
          expect(product(head!, t), `head at frame ${frame}`).toBeCloseTo(w * fadeWeight(bEdges, 2, 4, t), 3);
          checked++;
        }
        // Upper track: u1 rides 1 - w after its own fade-free life, the logo w times its fade in.
        const logoEdges = upper.get("logo")!;
        const u1 = lines.find((line) => line.includes("aa=0.6"));
        const logoLine = lines.find((line) => line.includes("eval=frame,setsar=1"));
        const w = dissolveProgress(1, logoEdges.dissolve, t);
        if (u1 && frame < 36) {
          expect(product(u1, t), `u1 at frame ${frame}`).toBeCloseTo(dissolveWeights(w, "upper").outgoing, 3);
          checked++;
        }
        if (logoLine && frame >= 24 && frame < 120) {
          const expected = dissolveWeights(w, "upper").incoming * fadeWeight(logoEdges, 1, 4, t);
          expect(product(logoLine, t), `logo at frame ${frame}`).toBeCloseTo(expected, 3);
          checked++;
        }
      }
    }
    expect(checked).toBe(18 + 36 + 96);
  });

  it("writes sound ramps and gain keys whose envelope is gainAt with fadeWeight on every sample", () => {
    const item = plan.audio.tracks.flat().find((candidate) => candidate.kind === "clip" && candidate.clip === "music");
    expect(item?.kind).toBe("clip");
    if (item?.kind !== "clip") return;
    const { sampleRate } = plan.audio;
    const edges = edgeTransitions([music], { fps, sourceDuration: () => 60 }).get("music")!;
    /** afade with curve=qsin at output sample `n` of the item, as af_afade computes it. */
    const afade = (type: string, ss: number, ns: number, n: number) => {
      const index = type === "in" ? n - ss : ss + ns - n;
      return Math.sin((Math.min(1, Math.max(0, index / ns)) * Math.PI) / 2);
    };
    for (let n = 0; n < item.samples; n += 97) {
      const t = n / sampleRate;
      const ramps = (item.ramps ?? []).reduce((p, ramp) => p * afade(ramp.type, ramp.start, ramp.length, n), 1);
      const gain = 10 ** (evaluate(item.gain!, { t }) / 20);
      const expected = 10 ** (gainAt(music, t) / 20) * fadeWeight(edges, 0, 4, t, true);
      expect(ramps * gain, `sample ${n}`).toBeCloseTo(expected, 4);
    }
  });

  it("sets keyed opacity on every frame to keyedValueAt through sendcmd", () => {
    const clip: Clip = {
      id: "p",
      type: "media",
      asset: "assets/logo.png",
      start: 0.5,
      in: 0,
      out: 2,
      keys: {
        opacity: [
          { at: 0.2, value: 0.1, ease: "in-out" },
          { at: 1.4, value: 0.9, ease: "out" },
          { at: 1.8, value: 0.5 },
        ],
      },
    };
    const single: Timeline = { schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [{ ...clip, transform: { scale: 0.5 } }] }] };
    const opacityPlan = compileRender({ timeline: single, fps, preset, loudness: -17, sources, resolution, segmentSeconds: 0.9 });
    let checked = 0;
    for (const segment of opacityPlan.segments) {
      const text = opacityPlan.files[segment.args[segment.args.indexOf("-/filter_complex") + 1]!]!;
      const initial = /colorchannelmixer@(o\d+)=aa=([\d.]+)/.exec(text)!;
      const commands = [...text.matchAll(/([\d.]+) \[enter\] colorchannelmixer@o\d+ aa ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const from = Math.max(Math.round(segment.from * fps), 15);
      for (let frame = from; frame < Math.round(segment.to * fps); frame++) {
        const t = frame / fps;
        // The value in force at a frame: the last command at or before it, else the initial one.
        const value = commands.filter(([at]) => at <= t).at(-1)?.[1] ?? Number(initial[2]);
        expect(value, `frame ${frame}`).toBeCloseTo(keyedValueAt(clip.keys!.opacity, clipTime(clip, t))!, 5);
        checked++;
      }
    }
    expect(checked).toBe(60);
  });
});

describe("nested clip parity (ADR 0018 decision 9)", () => {
  const fps = 30;
  const preset = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
  const resolution = { width: 1280, height: 720 };
  const sources = new Map<string, ExportSource>([
    ["assets/talk.mp4", { path: "/p/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 30 }],
    ["assets/logo.png", { path: "/p/logo.png", video: { codec: "png", still: true, width: 500, height: 300 }, audio: false }],
    ["assets/music.wav", { path: "/p/music.wav", video: null, audio: true, duration: 60 }],
  ]);
  // Scene: a badge with opacity keys on V1, a music bed with gain keys from 1 s on A1.
  const scene: Timeline = {
    schemaVersion: 1,
    id: "scene",
    revision: 1,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          {
            id: "badge",
            type: "media",
            asset: "assets/logo.png",
            start: 0,
            in: 0,
            out: 4,
            transform: { x: 120, scale: 0.4 },
            keys: {
              opacity: [
                { at: 0.5, value: 0.4, ease: "in" },
                { at: 2.5, value: 1 },
              ],
            },
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        clips: [
          {
            id: "bed",
            type: "media",
            asset: "assets/music.wav",
            start: 1,
            in: 5,
            out: 9,
            keys: {
              gain: [
                { at: 6, value: -18, ease: "in-out" },
                { at: 8, value: -6 },
              ],
            },
          },
        ],
      },
    ],
  };
  // Scene seconds 0.5 to 3 at 1 s on V2, dissolving from a still, every placement property and gain keyed, faded.
  const main: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "bg", type: "media", asset: "assets/talk.mp4", start: 0, in: 3, out: 7 }] },
      {
        id: "v2",
        kind: "video",
        clips: [
          { id: "pre", type: "media", asset: "assets/logo.png", start: 0, in: 0, out: 1, transform: { scale: 0.3 } },
          {
            id: "n",
            type: "timeline",
            source: "timelines/scene.json",
            start: 1,
            in: 0.5,
            duration: 2.5,
            transform: { y: -30 },
            audio: { gain: -3 },
            dissolve: 0.6,
            fadeIn: 0.8,
            fadeOut: 0.5,
            keys: {
              x: [
                { at: 0.5, value: -200, ease: "in-out" },
                { at: 2.5, value: 150 },
              ],
              scale: [
                { at: 1, value: 0.8, ease: "out" },
                { at: 3, value: 1.3 },
              ],
              opacity: [
                { at: 0.5, value: 1 },
                { at: 3, value: 0.5 },
              ],
              gain: [
                { at: 1, value: 0 },
                { at: 3, value: -10, ease: "in" },
              ],
            },
          },
        ],
      },
    ],
  };
  const flat = flattenTimeline(main, (source) => (source === "timelines/scene.json" ? scene : null), fps);
  const clipOf = (track: string, id: string) => (flat.tracks.find((candidate) => candidate.id === track) as { clips: Clip[] }).clips.find((clip) => clip.id === id)!;
  const badge = clipOf("v2", "n/badge");
  const bed = clipOf("v2/a1", "n/bed");
  const plan = compileRender({ timeline: flat, fps, preset, loudness: -17, sources, resolution, segmentSeconds: 0.7 });
  const filters = plan.segments.map((segment) => ({ segment, text: plan.files[segment.args[segment.args.indexOf("-/filter_complex") + 1]!]! }));
  /** The badge is drawn from 9 frames before 1 s (its dissolve's head) to 3.5 s. */
  const [first, last] = [21, 105];
  /** Product of the host fades of `clip` at `t`, as the preview multiplies them in. */
  const hostWeight = (clip: Clip, t: number, sound = false) => hostFades(clip).reduce((w, fade) => w * fadeWeight(fade, fade.start, fade.end, t, sound), 1);

  it("writes the badge's scale and position as layerRect(placementAt) with the host's keys composed in, on every frame", () => {
    let checked = 0;
    for (const { segment, text } of filters) {
      const scale = /scale=w='([^']+)':h='([^']+)':eval=frame/.exec(text);
      const overlay = /overlay=x='([^']+)':y='([^']+)':eval=frame/.exec(text);
      const from = Math.max(first, Math.round(segment.from * fps));
      const to = Math.min(last, Math.round(segment.to * fps));
      if (to <= from) continue;
      expect(scale && overlay, `segment ${segment.file}`).toBeTruthy();
      for (let frame = from; frame < to; frame++) {
        const t = frame / fps;
        const expected = layerRect({ width: 500, height: 300 }, preset.video, resolution, placementAt(badge, t));
        const width = evaluate(scale![1]!, { t });
        const height = evaluate(scale![2]!, { t });
        const vars = { t: t - segment.from, overlay_w: width, overlay_h: height };
        expect([width, height, evaluate(overlay![1]!, vars), evaluate(overlay![2]!, vars)], `frame ${frame}`).toEqual([
          expected.width,
          expected.height,
          expected.left,
          expected.top,
        ]);
        checked++;
      }
    }
    expect(checked).toBe(last - first);
  });

  it("multiplies the badge by its dissolve and the host's fades, and sets its opacity to placementAt's", () => {
    const fade = (type: string, st: number, d: number, t: number) => {
      const f = Math.min(1, Math.max(0, (t - st) / d));
      return type === "in" ? f : 1 - f;
    };
    let checked = 0;
    for (const { segment, text } of filters) {
      const line = text.split(";\n").find((candidate) => candidate.includes("eval=frame,setsar=1"));
      if (!line) continue;
      const initial = /colorchannelmixer@o\d+=aa=([\d.]+)/.exec(line)!;
      const commands = [...line.matchAll(/([\d.]+) \[enter\] colorchannelmixer@o\d+ aa ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      for (let frame = Math.max(first, Math.round(segment.from * fps)); frame < Math.min(last, Math.round(segment.to * fps)); frame++) {
        const t = frame / fps;
        const ramps = [...line.matchAll(/fade=t=(in|out):alpha=1:st=([\d.]+):d=([\d.]+)/g)].reduce((p, m) => p * fade(m[1]!, Number(m[2]), Number(m[3]), t), 1);
        const incoming = dissolveWeights(dissolveProgress(1, 0.3, t), "upper").incoming;
        expect(ramps, `ramps at frame ${frame}`).toBeCloseTo(incoming * hostWeight(badge, t), 3);
        const opacity = commands.filter(([at]) => at <= t).at(-1)?.[1] ?? Number(initial[1]);
        expect(opacity, `opacity at frame ${frame}`).toBeCloseTo(placementAt(badge, t).opacity, 5);
        checked++;
      }
    }
    expect(checked).toBe(last - first);
  });

  it("plays the bed at gainAt with the host's keys, times the host's fades, one begun before the bed starts", () => {
    const item = plan.audio.tracks.flat().find((candidate) => candidate.kind === "clip" && candidate.clip === "n/bed");
    if (item?.kind !== "clip") throw new Error("no bed item");
    // The host fades in over 1-1.8 s; the bed starts at 1.5 s, so that ramp is a volume factor, not an afade.
    expect(item.fade).toBeDefined();
    const { sampleRate } = plan.audio;
    const afade = (type: string, ss: number, ns: number, n: number) => {
      const index = type === "in" ? n - ss : ss + ns - n;
      return Math.sin((Math.min(1, Math.max(0, index / ns)) * Math.PI) / 2);
    };
    for (let n = 0; n < item.samples; n += 97) {
      const t = n / sampleRate;
      const at = 1.5 + t;
      const ramps = (item.ramps ?? []).reduce((p, ramp) => p * afade(ramp.type, ramp.start, ramp.length, n), 1);
      const volume = 10 ** (evaluate(item.gain!, { t }) / 20) * evaluate(item.fade!, { t });
      expect(ramps * volume, `sample ${n}`).toBeCloseTo(10 ** (gainAt(bed, at) / 20) * hostWeight(bed, at, true), 4);
    }
  });
});
