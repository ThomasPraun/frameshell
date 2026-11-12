import { type ExportSource, type MatteSource, compileFrame } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Clip, Timeline } from "@frameshell/schema";
import { flattenTimeline } from "@frameshell/schema/composite";
import { describe, expect, it } from "vitest";
import {
  type PlacedSpan,
  type Program,
  type VideoSpan,
  compileProgram,
  placeholdersAt,
  programAt,
  readyMattes,
  spanShape,
} from "../src/renderer/src/preview/program.js";
import { syncTable } from "../src/renderer/src/preview/decode-plan.js";
import { type VideoSource, mattedPath, mattedSource, splitMattedPath } from "../src/renderer/src/preview/video-source.js";

// Seam under test: subject layers (ADR 0032) in the preview program, against the export compiler on the same timeline.

const FPS = 30;
const TALK = "assets/talk.mp4";
const BROLL = "assets/broll.mp4";
const WORD = "assets/word.png";
const MATTE = ".frameshell/cache/mattes/0123-m1-abcd.mp4";

function video(path: string): AssetInfo {
  const key = path.replace(/\W/g, "");
  return {
    path,
    kind: "media",
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
  };
}

const still: AssetInfo = {
  ...video(WORD),
  media: { duration: null, format: "png_pipe", video: { codec: "png", width: 1920, height: 1080, fps: 0, vfr: false, still: true }, audio: null },
  proxy: null,
  sidecar: null,
};
const ASSETS = new Map([TALK, BROLL].map((path) => [path, video(path)] as const)).set(WORD, still);
const MATTES = new Map([[TALK, MATTE]]);

const media = (id: string, asset: string, start: number, inS: number, out: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset, start, in: inS, out, ...extra }) as Clip;

/** Plate v1 (two talk clips, the second dissolving in), the word v2 behind it from 1 s to 4 s. */
function stack(plate: Partial<Record<"a" | "b", Partial<Clip>>> = {}, extra: Timeline["tracks"] = []): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [media("c_a", TALK, 0, 2, 5, plate.a), media("c_b", TALK, 3, 10, 14, { dissolve: 0.4, ...plate.b })] },
      ...extra,
      { id: "v2", kind: "video", behind: "v1", clips: [media("c_w", WORD, 1, 0, 3)] },
    ],
  };
}

/** `timeline` as `timeline.show` returns it: clips with their derived `end`. */
function viewOf(timeline: Timeline): TimelineView {
  const tracks = timeline.tracks.map((track) => {
    if (track.kind === "subtitles") throw new Error("no subtitles here");
    const clips = track.clips.map((clip) => {
      const { start, in: inS, out, speed } = clip as Clip & { in: number; out: number; speed?: number };
      return { ...clip, end: start + (out - inS) / (speed ?? 1) };
    });
    return { ...track, name: null, follows: null, clips };
  });
  return { timeline: timeline.id, path: `timelines/${timeline.id}.json`, revision: timeline.revision, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
}

const program = (timeline: Timeline, mattes: ReadonlyMap<string, string> = MATTES) => compileProgram(viewOf(timeline), ASSETS, { mattes });

/** Subject spans (with a matte) showing at `frame`, bottom first. */
const subjectsAt = (shown: Program, frame: number) =>
  shown.layers.flatMap((_, layer) => {
    const span = programAt(shown, frame, layer);
    return span?.kind === "media" && span.matte !== undefined ? [span] : [];
  });

/** Source frame `span` shows at program `frame`, as `decodeSteps` picks it. */
const sourceFrame = (span: Extract<VideoSpan, { kind: "media" }>, frame: number) => Math.round(span.in + (frame - span.start) * span.speed);

const SOURCES = new Map<string, ExportSource>([
  [TALK, { path: "/abs/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 600 }],
  [BROLL, { path: "/abs/broll.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 600 }],
  [WORD, { path: "/abs/word.png", video: { codec: "png", still: true, width: 1920, height: 1080 }, audio: false }],
]);
const EXPORT_MATTES = new Map<string, MatteSource>([[TALK, { path: "/abs/matte.mp4", width: 960, height: 540 }]]);

/** Matte inputs export reads for the frame captured at program frame `frame`: one per subject piece it draws. */
function exportedSubjects(timeline: Timeline, frame: number): number {
  const plan = compileFrame({
    timeline: flattenTimeline(timeline, () => null, FPS),
    fps: FPS,
    sources: SOURCES,
    mattes: EXPORT_MATTES,
    resolution: { width: 1920, height: 1080 },
    width: 960,
    height: 540,
    at: frame / FPS,
    output: "frame.png",
  });
  return plan.args.filter((arg, i) => plan.args[i - 1] === "-i" && arg === "/abs/matte.mp4").length;
}

describe("subject layers in the preview (ADR 0032)", () => {
  it("draws the plate's clips again through the matte above the track behind it, only while that track shows", () => {
    const shown = program(stack());
    // Plate, the word, the plate's dissolve slot, then the subject layer (and its own dissolve slot) above the word.
    expect(shown.layers.length).toBeGreaterThanOrEqual(3);
    expect(subjectsAt(shown, 15)).toEqual([]);
    expect(subjectsAt(shown, 30)).toHaveLength(1);
    expect(subjectsAt(shown, 30)[0]).toMatchObject({ clip: "c_a", proxy: video(TALK).proxy, matte: MATTE, start: 30 });
    expect(subjectsAt(shown, 119)).toHaveLength(1);
    expect(subjectsAt(shown, 120)).toEqual([]);
    // Frame N of the matte is frame N of the proxy: the subject reads the source frame the plate shows.
    for (const frame of [30, 60, 84, 95, 100, 119]) {
      const plate = programAt(shown, frame, 0) as Extract<VideoSpan, { kind: "media" }>;
      const subject = subjectsAt(shown, frame).find((span) => span.clip === plate.clip);
      if (subject) expect(sourceFrame(subject, frame)).toBe(sourceFrame(plate, frame));
    }
  });

  it("shows the plate as it is, with a matte note, while the matte is not ready; nothing behind, nothing added", () => {
    const waiting = program(stack(), new Map());
    expect(subjectsAt(waiting, 60)).toEqual([]);
    expect(placeholdersAt(waiting, 60).notes).toEqual([expect.objectContaining({ span: expect.objectContaining({ reason: "matte", clip: "c_a" }) })]);
    expect(placeholdersAt(waiting, 15).notes).toEqual([]);
    const plain = stack();
    delete (plain.tracks[1] as { behind?: string }).behind;
    expect(program(plain).layers.flat().some((span) => span.kind === "media" && span.matte !== undefined)).toBe(false);
    expect(placeholdersAt(program(plain, new Map()), 60).notes).toEqual([]);
  });

  it("notes a subject of a plate with its own alpha instead of drawing it", () => {
    const alpha = new Map(ASSETS).set(TALK, { ...video(TALK), proxy: ".frameshell/proxies/talk.webm" });
    const shown = compileProgram(viewOf(stack()), alpha, { mattes: MATTES });
    expect(subjectsAt(shown, 60)).toEqual([]);
    expect(placeholdersAt(shown, 60).notes).toEqual([expect.objectContaining({ span: expect.objectContaining({ reason: "matteAlpha", clip: "c_a" }) })]);
  });

  it("takes only ready mattes from matte.status", () => {
    const base = { matte: null, progress: 0, job: null, error: null };
    expect(
      readyMattes([
        { ...base, asset: TALK, state: "ready", matte: MATTE, progress: 1 },
        { ...base, asset: BROLL, state: "making", job: "j_1" },
      ]),
    ).toEqual(new Map([[TALK, MATTE]]));
  });

  it("gives a subject of a base plate clip its wipe, the outgoing one the rest of the frame", () => {
    const shown = program(stack({ b: { shape: { kind: "wipe", direction: "left" } } }));
    // Half way through the wipe at 3 s: the incoming plate clip shows on the right half, the outgoing subject on the left.
    const subjects = subjectsAt(shown, 90);
    const outgoing = subjects.find((span) => span.clip === "c_a")!;
    const incoming = subjects.find((span) => span.clip === "c_b")!;
    const rect = (span: PlacedSpan) => spanShape(span, 90, FPS)?.clip;
    const [x0] = rect(incoming)!;
    expect(x0).toBeGreaterThan(0.3);
    expect(rect(outgoing)).toEqual([0, 0, x0, 1]);
  });

  it("decodes a subject from its proxy with the matte as alpha, starting where both files have a keyframe", async () => {
    const file = (keys: number[], count: number, tag: number): VideoSource => ({
      config: { codec: `avc1.${tag}`, codedWidth: 960, codedHeight: 540 },
      hasAlpha: false,
      table: syncTable(Array.from({ length: count }, (_, i) => keys.includes(i))),
      read: async (from, to) =>
        Array.from({ length: Math.max(0, Math.min(to, count) - from) }, (_, i) => ({ data: new Uint8Array([tag, from + i]), key: keys.includes(from + i), alpha: null })),
    });
    const path = mattedPath(".frameshell/proxies/talk.mp4", MATTE);
    expect(splitMattedPath(path)).toEqual({ picture: ".frameshell/proxies/talk.mp4", matte: MATTE });
    expect(splitMattedPath(".frameshell/proxies/talk.mp4")).toBeNull();
    const source = mattedSource(file([0, 15, 30], 40, 1), file([0, 30], 35, 2));
    expect(source).toMatchObject({ hasAlpha: true, config: { codec: "avc1.1" }, alphaConfig: { codec: "avc1.2" } });
    // The matte has no keyframe at 15: decoding frame 20 starts at 0. The shorter file ends the source.
    expect([source.table.count, source.table.before(20), source.table.before(31)]).toEqual([35, 0, 30]);
    const pictures = await source.read(29, 40);
    expect(pictures).toHaveLength(6);
    expect(pictures[1]).toEqual({ data: new Uint8Array([1, 30]), key: true, alpha: { data: new Uint8Array([2, 30]), key: true } });
  });

  describe("draws a subject on the frames export does", () => {
    const cases: [string, Timeline][] = [
      ["a plate with a dissolve", stack()],
      ["a sped-up plate clip with an in point", stack({ a: { in: 2, out: 8, speed: 2 } })],
      ["a wiped base plate", stack({ b: { shape: { kind: "wipe", direction: "left" } } })],
      ["a cutaway between the plate and the word", stack({}, [{ id: "v_c", kind: "video", clips: [media("c_c", BROLL, 2, 0, 0.5)] }])],
      [
        "an upper, scaled plate",
        {
          ...stack({ a: { transform: { scale: 0.5 } }, b: { transform: { scale: 0.5 } } }),
          tracks: [{ id: "v0", kind: "video", clips: [media("c_bg", BROLL, 0, 0, 8)] }, ...stack({ a: { transform: { scale: 0.5 } }, b: { transform: { scale: 0.5 } } }).tracks],
        },
      ],
    ];
    for (const [name, timeline] of cases) {
      it(name, () => {
        const shown = program(timeline);
        const frames = Array.from({ length: shown.frames }, (_, frame) => frame);
        const preview = frames.map((frame) => subjectsAt(shown, frame).length);
        expect(preview.some((count) => count > 0)).toBe(true);
        expect(preview).toEqual(frames.map((frame) => exportedSubjects(timeline, frame)));
      });
    }
  });
});
