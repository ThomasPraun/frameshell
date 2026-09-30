import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import {
  BUILTIN_PRESETS,
  type ExportSource,
  compileFrame,
  compileRender,
  loudnessAnalysis,
  mixStep,
  muxStep,
  parseLoudnessStats,
} from "../src/index.js";

// Golden files: reviewed ffmpeg plans. Regenerate with UPDATE_GOLDEN=1 and review the diff.
const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

function golden(name: string, actual: unknown): void {
  const path = `${GOLDEN_DIR}${name}.json`;
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env["UPDATE_GOLDEN"] || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, text);
    if (!process.env["UPDATE_GOLDEN"]) throw new Error(`golden ${name} was missing and has been written; review and rerun`);
  }
  expect(text).toBe(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

const youtube1080 = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
/** `frameshell.json` resolution: transform offsets are in these pixels. */
const resolution = { width: 1920, height: 1080 };

const sources = new Map<string, ExportSource>([
  ["assets/talk.mp4", { path: "/project/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true }],
  ["assets/title.webm", { path: "/project/assets/title.webm", video: { codec: "vp9", still: false, width: 1920, height: 1080 }, audio: false }],
  ["assets/logo.png", { path: "/project/assets/logo.png", video: { codec: "png", still: true, width: 500, height: 500 }, audio: false }],
  ["assets/music.wav", { path: "/project/assets/music.wav", video: null, audio: true }],
]);

/**
 * 8 s at 30 fps: cut talk (3 s), the same source at 1.15x (2 s), a 1 s gap,
 * a VP9 title (1 s), a still (1 s); music under it all at -18 dB; subtitles.
 */
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 12,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_talk1", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 6.2 },
        { id: "c_talk2", type: "media", asset: "assets/talk.mp4", start: 3, in: 10, out: 12.3, speed: 1.15 },
        { id: "c_title", type: "media", asset: "assets/title.webm", start: 6, in: 0, out: 1 },
        { id: "c_logo", type: "media", asset: "assets/logo.png", start: 7, in: 0, out: 1 },
      ],
    },
    { id: "a1", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 8, audio: { gain: -18 } }] },
    { id: "s1", kind: "subtitles", follows: "v1" },
  ],
};

const MEASURED = { input_i: "-23.10", input_tp: "-6.20", input_lra: "4.30", input_thresh: "-33.40", target_offset: "0.40" };

describe("export compiler", () => {
  const plan = compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 4 });

  it("compiles a cut list to segments, one audio pass and a mux (golden)", () => {
    golden("render-plan", {
      plan,
      mix: mixStep(plan),
      loudnessAnalysis: loudnessAnalysis(plan),
      mux: muxStep(plan, MEASURED, "/out/main.mp4.partial"),
    });
  });

  it("covers the timeline exactly: 240 frames at 30 fps, 384 000 samples per audio track", () => {
    expect(plan).toMatchObject({ frames: 240, duration: 8, fps: "30/1", width: 1920, height: 1080 });
    // Segments end on clip edges when one is in their second half (90 = end of the first cut, 210 = end of the title).
    expect(plan.segments.map((s) => [s.from, s.to, s.frames])).toEqual([
      [0, 3, 90],
      [3, 7, 120],
      [7, 8, 30],
    ]);
    for (const track of plan.audio.tracks) {
      expect(track.reduce((sum, item) => sum + item.samples, 0)).toBe(384_000);
    }
    expect(plan.files["segments.txt"]).toBe("file 'seg-0001.mp4'\nfile 'seg-0002.mp4'\nfile 'seg-0003.mp4'\n");
  });

  it("decodes every VP9 input with libvpx so alpha survives (ADR 0002)", () => {
    const args = plan.segments[1]!.args;
    const input = args.indexOf("/project/assets/title.webm");
    expect(args.slice(input - 7, input + 1)).toEqual(["-c:v", "libvpx-vp9", "-ss", "0", "-t", "2", "-i", "/project/assets/title.webm"]);
    const h264 = args.indexOf("/project/assets/talk.mp4");
    expect(args.slice(0, h264)).not.toContain("libvpx-vp9");
  });

  it("maps speed to atempo and gain to volume, with a 2 ms fade at both edges of every clip", () => {
    const [video, music] = plan.audio.tracks;
    // 1.15x for 2 s of timeline reads 2.3 s of source from 10 s: samples 480 000 to 590 400.
    expect(video![1]).toEqual({ kind: "clip", clip: "c_talk2", input: 0, from: 480_000, to: 590_400, speed: 1.15, gainDb: 0, samples: 96_000 });
    expect(music![0]).toMatchObject({ kind: "clip", clip: "c_music", gainDb: -18, samples: 384_000 });
    const graph = mixStep(plan)!.files["mix.filter"]!;
    expect(graph).toContain("atempo=1.15");
    expect(graph).toContain("volume=-18dB");
    expect(graph.match(/afade=t=in:ss=0:ns=96,/g)).toHaveLength(3);
  });

  it("reports what export v1 skips", () => {
    expect(plan.warnings).toEqual(["Subtitle track s1 is not burned into exports yet; it was skipped."]);
  });

  it("composites upper video tracks over the base with each clip's transform (golden)", () => {
    const overlays: Timeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: "v2",
          kind: "video",
          clips: [
            // Logo a quarter of the frame height, top right, 80 % opaque, from 1 s to 3 s.
            { id: "c_logo2", type: "media", asset: "assets/logo.png", start: 1, in: 0, out: 2, transform: { x: 600, y: -300, scale: 0.25, opacity: 0.8 } },
            // VP9 title at half size over the second cut.
            { id: "c_title2", type: "media", asset: "assets/title.webm", start: 4, in: 0, out: 1, transform: { scale: 0.5 } },
          ],
        },
      ],
    };
    const overlayPlan = compileRender({ timeline: overlays, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 4 });
    const frame = (at: number) => compileFrame({ timeline: overlays, fps: 30, sources, resolution, width: 1280, height: 720, at, output: "/out/frame.png" });
    golden("overlay-plan", { segments: overlayPlan.segments, files: overlayPlan.files, frames: { logo: frame(2), title: frame(4.5), none: frame(3.5) } });

    expect(overlayPlan.warnings).toEqual(["Subtitle track s1 is not burned into exports yet; it was skipped."]);
    const first = overlayPlan.files["seg-0001.filter"]!;
    // Pillarboxed 1080x1080 at 0.25 = 270 px, centered 600 px right and 300 px up; starts 30 frames into the segment.
    expect(first).toContain("scale=270:270,setsar=1,format=rgba,colorchannelmixer=aa=0.8,tpad=start=30:color=black@0[o0]");
    expect(first).toContain("[base][o0]overlay=x=1425:y=105:eof_action=pass:format=auto");
    const second = overlayPlan.segments[1]!.args;
    const title = second.indexOf("/project/assets/title.webm");
    // ADR 0002 holds for overlays too: libvpx keeps the title's alpha.
    expect(second.slice(title - 7, title - 5)).toEqual(["-c:v", "libvpx-vp9"]);
    expect(overlayPlan.files["seg-0002.filter"]).toContain("scale=960:540");
    // Sound is untouched by overlays that have none.
    expect(overlayPlan.audio).toEqual(plan.audio);
    // The frame at 3.5 s has no overlay: same graph as without v2.
    expect(frame(3.5).args).toEqual(compileFrame({ timeline, fps: 30, sources, resolution, width: 1280, height: 720, at: 3.5, output: "/out/frame.png" }).args);
  });

  it("places a transformed clip of the base track over black", () => {
    const moved: Timeline = {
      ...timeline,
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_small", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 1, transform: { scale: 0.5, x: -480 } }] }],
    };
    const { args } = compileFrame({ timeline: moved, fps: 30, sources, resolution, width: 1920, height: 1080, at: 0.5, output: "/out/f.png" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/^color=c=black:s=1920x1080:r=30\/1,trim=end_frame=1,setsar=1,format=rgb24\[p0\];\[p0\]null\[base\];/);
    expect(graph).toContain("scale=960:540,setsar=1,format=rgba[o0];[base][o0]overlay=x=0:y=270:eof_action=pass:format=auto,format=rgb24");
  });

  it("refuses adapter clips and unresolved nested timelines on any track, naming the clip and the fix", () => {
    const adapter: Timeline = {
      ...timeline,
      tracks: [...timeline.tracks, { id: "v2", kind: "video", clips: [{ id: "c_hf", type: "hyperframes", start: 0, duration: 2 }] }],
    };
    expect(() => compileRender({ timeline: adapter, fps: 30, preset: youtube1080, loudness: -17, sources, resolution })).toThrow(
      expect.objectContaining({ code: ErrorCode.ExportUnsupported, message: expect.stringContaining("frameshell clip remove c_hf"), data: { timeline: "main", track: "v2", clip: "c_hf" } }),
    );
    const nested: Timeline = {
      ...timeline,
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_intro", type: "timeline", source: "timelines/intro.json", start: 0, duration: 2 }] }],
    };
    expect(() => compileRender({ timeline: nested, fps: 30, preset: youtube1080, loudness: -17, sources, resolution })).toThrow(
      expect.objectContaining({ code: ErrorCode.ExportUnsupported, message: expect.stringContaining("timelines/intro.json") }),
    );
  });

  it("refuses an empty timeline", () => {
    const empty: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [] }] };
    expect(() => compileRender({ timeline: empty, fps: 30, preset: youtube1080, loudness: -17, sources, resolution })).toThrow(
      expect.objectContaining({ code: ErrorCode.ExportUnsupported }),
    );
  });

  it("renders a timeline without sound as a silent track and skips loudness", () => {
    const silent: Timeline = { ...timeline, tracks: [timeline.tracks[0]!] };
    const silentSources = new Map([...sources].map(([key, source]) => [key, { ...source, audio: false }]));
    const silentPlan = compileRender({ timeline: silent, fps: 30, preset: youtube1080, loudness: -17, sources: silentSources, resolution });
    expect(silentPlan.audio.tracks).toEqual([]);
    expect(mixStep(silentPlan)).toBeNull();
    expect(loudnessAnalysis(silentPlan)).toBeNull();
    expect(muxStep(silentPlan, null, "/out/x.mp4").args).toContain("anullsrc=r=48000:cl=stereo,atrim=end_sample=384000[a]");
  });

  it("plans single frames: in a cut, in a sped-up clip, in a gap and on a still (golden)", () => {
    const frame = (at: number) =>
      compileFrame({ timeline, fps: 30, sources, resolution, width: 1280, height: 720, at, output: "/out/frame.png" });
    golden("frame-plans", { cut: frame(1), speed: frame(3.5), gap: frame(5.5), still: frame(7.5) });
    expect(frame(3.5)).toMatchObject({ frame: 105, at: 3.5, clip: "c_talk2" });
    expect(frame(5.5)).toMatchObject({ frame: 165, clip: null });
    // 3-decimal times name the frame they were rounded from: 0.033 is frame 1 at 30 fps.
    expect(frame(0.033).frame).toBe(1);
  });

  it("refuses a frame outside the timeline with the valid range", () => {
    expect(() => compileFrame({ timeline, fps: 30, sources, resolution, width: 64, height: 36, at: 8, output: "x.png" })).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidOperation, data: expect.objectContaining({ valid: { min: 0, max: 7.967 } }) }),
    );
  });

  it("reads loudnorm stats, treating a silent measurement as nothing to normalize", () => {
    const stats = (i: string) => JSON.stringify({ ...MEASURED, input_i: i, output_i: "-17.0" });
    expect(parseLoudnessStats(stats("-23.10"))).toEqual(MEASURED);
    expect(parseLoudnessStats(stats("-inf"))).toBeNull();
  });
});
