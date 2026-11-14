import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import {
  type AudioEffect,
  type Clip,
  type ClipTrack,
  type ExportPreset,
  type MediaClip,
  type Timeline,
  type Transcript,
  type TransitionShape,
  VOICE_CHAIN,
  audioFadeGain,
  audioFades,
  bakeRef,
  flattenTimeline,
  gradeKey,
  gradeOf,
  resolveFormat,
} from "@frameshell/schema";
import {
  type AudioItem,
  BUILTIN_PRESETS,
  type ExportSource,
  assCentiseconds,
  compileFrame,
  compileRender,
  fitInside,
  gifStep,
  loudnessAnalysis,
  mixStep,
  muxStep,
  paletteStep,
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

/** A preset with sound: its `audio` is never undefined. */
const youtube1080 = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")! as ExportPreset & { audio: NonNullable<ExportPreset["audio"]> };
/** `frameshell.json` resolution: transform offsets are in these pixels. */
const resolution = { width: 1920, height: 1080 };

const sources = new Map<string, ExportSource>([
  ["assets/talk.mp4", { path: "/project/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true }],
  ["assets/title.webm", { path: "/project/assets/title.webm", video: { codec: "vp9", still: false, width: 1920, height: 1080, alpha: true }, audio: false }],
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

/**
 * Words of talk.mp4 (source seconds). c_talk1 plays 3.2-6.2 from 0 s, c_talk2 plays 10-12.3 at 1.15x from 3 s:
 * "silencios" (midpoint 6.3) and "ayer" (7.0) fall in the cut, "rápido" plays at 3.174-3.522 s.
 */
const talkWords: [string, number, number][] = [
  ["Hola", 3.3, 3.6],
  ["a", 3.7, 3.8],
  ["todos.", 3.9, 4.4],
  ["Hoy", 5.0, 5.3],
  ["cortamos", 5.4, 5.9],
  ["silencios", 6.0, 6.6],
  ["ayer", 6.8, 7.2],
  ["rápido", 10.2, 10.6],
];
const talkTranscript: Transcript = {
  schemaVersion: 1,
  asset: "assets/talk.mp4",
  assetHash: `sha256:${"a".repeat(64)}`,
  provider: "whisper-cpp",
  model: "large-v3-turbo-q5_0",
  words: talkWords.map(([text, start, end], i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text, start, end })),
  edits: {},
};
const transcripts = new Map([["assets/talk.mp4", talkTranscript]]);

describe("export compiler", () => {
  const plan = compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4 });

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

  describe("quality tiers", () => {
    const encodeArgs = (p: ReturnType<typeof compileRender>) => p.segments[0]!.args;

    it("encodes a draft with the picked encoder at 30 fps at most, even from a 60 fps project", () => {
      const draft = compileRender({ timeline, fps: 60, preset: youtube1080, loudness: -17, sources, resolution, encode: { encoder: "libx264", tier: "draft" } });
      expect(draft.fps).toBe("30/1");
      const args = encodeArgs(draft);
      expect(args.slice(args.lastIndexOf("-c:v"), args.lastIndexOf("-c:v") + 8)).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-profile:v", "high"]);
      expect(args).not.toContain("-maxrate");
      expect(args).not.toContain("-colorspace");
      expect(draft.frames).toBe(Math.round(draft.duration * 30));
    });

    it("keeps a draft below 30 fps as it is", () => {
      expect(compileRender({ timeline, fps: 24, preset: youtube1080, loudness: -17, sources, resolution, encode: { encoder: "libx264", tier: "draft" } }).fps).toBe("24/1");
    });

    it("encodes a final slow with bt709 tags and AAC 320k, replacing the preset's rate", () => {
      const low = { ...youtube1080, audio: { ...youtube1080.audio, bitrateKbps: 128 } };
      const final = compileRender({ timeline, fps: 30, preset: low, loudness: -17, sources, resolution, encode: { encoder: "h264_nvenc", tier: "final" } });
      const args = encodeArgs(final).join(" ");
      expect(args).toContain("-c:v h264_nvenc -preset p6 -rc vbr -cq 17 -b:v 0");
      expect(args).toContain("-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv");
      expect(args).not.toContain("-crf 18");
      expect(final.audio.codec).toEqual(["-c:a", "aac", "-b:a", "320k", "-ar", "48000"]);
      expect(muxStep(final, null, "/out.mp4").args).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
    });

    it("sets the VideoToolbox bitrate from the frame size and rate", () => {
      const final = compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, encode: { encoder: "h264_videotoolbox", tier: "final" } });
      // 1920 x 1080 x 30 x 0.25 bits per pixel.
      expect(encodeArgs(final).join(" ")).toContain("-c:v h264_videotoolbox -b:v 15552k");
    });

    it("leaves a draft's audio as the preset says", () => {
      const draft = compileRender({ timeline, fps: 30, preset: { ...youtube1080, audio: { ...youtube1080.audio, bitrateKbps: 128 } }, loudness: -17, sources, resolution, encode: { encoder: "libx264", tier: "draft" } });
      expect(draft.audio.codec).toContain("128k");
    });

    it("ignores the tier for a preset that is not H.264, with a warning, and plans nothing else differently", () => {
      const vp9 = { ...youtube1080, id: "web", container: "webm" as const, video: { ...youtube1080.video, codec: "vp9" as const }, audio: { codec: "opus" as const } };
      const plain = compileRender({ timeline, fps: 30, preset: vp9, loudness: -17, sources, resolution });
      const tiered = compileRender({ timeline, fps: 30, preset: vp9, loudness: -17, sources, resolution, encode: { encoder: "libx264", tier: "final" } });
      expect(tiered.warnings).toEqual([...plain.warnings, 'Quality "final" only applies to H.264 presets; web renders as written.']);
      expect(tiered.segments).toEqual(plain.segments);
    });
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

  it("burns the subtitle track: the followed clips' words on the frames they play, cut words gone (golden)", () => {
    expect(plan.warnings).toEqual([]);
    expect(plan.fonts).toEqual(["ArchivoBlack-Regular.ttf"]);
    const ass = plan.files["subtitles.ass"]!;
    expect(ass).toContain("PlayResX: 1920\nPlayResY: 1080");
    // big-keyword at 1080p: 70 px em (0.065 of the short side) = ASS size 70 * 1.347, 6.3 px outline, white on black.
    expect(ass).toContain("Style: t0,Archivo Black,94.29,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,6.3,0,2,0,0,0,1");
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:")).map((line) => line.split(",").slice(1, 3).join("-") + " " + line.slice(line.indexOf("}") + 1));
    // Hola 3.3 → 0.1 s (frame 3); a 3.7 → frame 15; todos. 3.9 → frame 21, until its end 4.4 → frame 36, a sentence end.
    // rápido: 3 + 0.2 / 1.15 = 3.174 s = frame 95, written as 3.16 s: ffmpeg sees frame 95 at 3166 ms, frame 94 at 3133 ms.
    expect(events).toEqual([
      "0:00:00.10-0:00:00.50 {\\c&H0026D4FF&}HOLA{\\c&H00FFFFFF&} A TODOS.",
      "0:00:00.50-0:00:00.70 HOLA {\\c&H0026D4FF&}A{\\c&H00FFFFFF&} TODOS.",
      "0:00:00.70-0:00:01.20 HOLA A {\\c&H0026D4FF&}TODOS.{\\c&H00FFFFFF&}",
      "0:00:01.80-0:00:02.20 {\\c&H0026D4FF&}HOY{\\c&H00FFFFFF&} CORTAMOS",
      "0:00:02.20-0:00:02.70 HOY {\\c&H0026D4FF&}CORTAMOS{\\c&H00FFFFFF&}",
      "0:00:03.16-0:00:03.53 {\\c&H0026D4FF&}RÁPIDO{\\c&H00FFFFFF&}",
    ]);
    // Bottom of the line box 12 % above the frame's bottom edge.
    expect(ass).toContain("{\\an2\\pos(960,950.4)}");
    // Burned in the segments showing cues, on timeline time; the last segment (7-8 s) shows none.
    expect(plan.files["seg-0001.filter"]).toContain(",ass=filename=subtitles.ass:fontsdir=fonts[v]");
    expect(plan.files["seg-0002.filter"]).toContain(",setpts=PTS+3/TB,ass=filename=subtitles.ass:fontsdir=fonts,setpts=PTS-STARTPTS[v]");
    expect(plan.files["seg-0003.filter"]).not.toContain("ass=");
  });

  it("writes cue edges so ffmpeg's truncated millisecond clock shows each cue on exactly its frames", () => {
    for (const fps of [24, 25, 30000 / 1001, 30, 50, 60]) {
      for (let frame = 1; frame < 5000; frame++) {
        const edge = assCentiseconds(frame, fps) * 10;
        // ffmpeg's ass filter: t = trunc(pts * 1000 / fps) ms; shown when start <= t < end.
        expect(Math.trunc((frame * 1000) / fps + 1e-6)).toBeGreaterThanOrEqual(edge);
        expect(Math.trunc(((frame - 1) * 1000) / fps + 1e-6)).toBeLessThan(edge);
      }
    }
  });

  it("warns when a followed clip with sound has no transcript, or a track names an unknown preset", () => {
    const styled: Timeline = { ...timeline, tracks: timeline.tracks.map((t) => (t.kind === "subtitles" ? { ...t, style: { preset: "neon" } } : t)) };
    const bare = compileRender({ timeline: styled, fps: 30, preset: youtube1080, loudness: -17, sources, resolution });
    expect(bare.warnings).toEqual([
      'Subtitle track s1 names unknown style preset "neon"; it was rendered as big-keyword.',
      "Subtitle track s1 shows no words for assets/talk.mp4: no transcript. Run `frameshell transcribe <asset>` first.",
    ]);
    expect(bare.files).not.toHaveProperty("subtitles.ass");
    expect(bare.fonts).toEqual([]);
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

    expect(overlayPlan.warnings).toEqual(["Subtitle track s1 shows no words for assets/talk.mp4: no transcript. Run `frameshell transcribe <asset>` first."]);
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

  it("leaves a hidden track's pictures out and keeps its sound; the next shown video track is the base", () => {
    const render = (tracks: Timeline["tracks"]) => compileRender({ timeline: { ...timeline, tracks }, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 4 });
    const [v1, a1] = timeline.tracks as [ClipTrack, ClipTrack];
    const logo = { id: "v2", kind: "video" as const, clips: [{ id: "c_logo2", type: "media" as const, asset: "assets/logo.png", start: 1, in: 0, out: 2 }] };
    const upperHidden = render([v1, a1, { ...logo, hidden: true }]);
    expect(upperHidden.segments).toEqual(render([v1, a1]).segments);
    const baseHidden = render([{ ...v1, hidden: true }, a1, logo]);
    expect(baseHidden.segments).toEqual(render([a1, logo]).segments);
    expect(baseHidden.frames).toBe(240);
    expect(baseHidden.audio).toEqual(plan.audio);
  });

  it("silences a muted track as if every clip on it were muted", () => {
    const [v1, a1] = timeline.tracks as [ClipTrack, ClipTrack];
    const render = (tracks: Timeline["tracks"]) => compileRender({ timeline: { ...timeline, tracks }, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 4 });
    const music = render([v1, { ...a1, muted: true }]);
    expect(music.audio.tracks).toHaveLength(1);
    expect(music.audio).toEqual(render([v1, { ...a1, clips: a1.clips.map((clip) => ({ ...clip, audio: { ...clip.audio, muted: true } })) }]).audio);
    expect(music.segments).toEqual(plan.segments);
    const silent = render([{ ...v1, muted: true }, { ...a1, muted: true }]);
    expect(silent.audio.tracks).toEqual([]);
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

  describe("generated clips (SPEC §3.5 step 2, ADR 0002)", () => {
    const layered: Timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 7.2 },
            // Over the black gap after the footage, opaque render.
            { id: "c_end", type: "hyperframes", source: "compositions/end/index.html", start: 4, duration: 1 },
          ],
        },
        {
          id: "v2",
          kind: "video",
          clips: [
            {
              id: "c_title",
              type: "hyperframes",
              source: "compositions/title/index.html",
              start: 1,
              in: 0.5,
              duration: 2,
              transform: { x: 100, y: -50, scale: 0.5, opacity: 0.8 },
            },
          ],
        },
      ],
    };
    const generated = new Map([
      ["c_title", { path: "/project/.frameshell/cache/clips/aaaa.webm", hasAlpha: true, width: 1920, height: 1080 }],
      ["c_end", { path: "/project/.frameshell/cache/clips/bbbb.mp4", hasAlpha: false, width: 1920, height: 1080 }],
    ]);
    const input = { timeline: layered, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, generated, segmentSeconds: 4 };
    const layeredPlan = compileRender(input);

    it("composites cached renders like footage: stacked by track, transformed, from the clip's in (golden)", () => {
      golden("generated-plan", {
        segments: layeredPlan.segments,
        files: layeredPlan.files,
        frame: compileFrame({ ...input, width: 1280, height: 720, at: 2, output: "/out/frame.png" }),
      });
      expect(layeredPlan).toMatchObject({ frames: 150, duration: 5 });
    });

    it("decodes alpha renders with libvpx from the clip's in point, opaque ones natively", () => {
      const [first, second] = layeredPlan.segments;
      const title = first!.args.indexOf("/project/.frameshell/cache/clips/aaaa.webm");
      // Render time 0.5 s shows at timeline 1 s: seeked 1 s of pre-roll back, clamped at 0.
      expect(first!.args.slice(title - 7, title + 1)).toEqual(["-c:v", "libvpx-vp9", "-ss", "0", "-t", "3.5", "-i", "/project/.frameshell/cache/clips/aaaa.webm"]);
      expect(layeredPlan.files["seg-0001.filter"]).toContain("colorchannelmixer=aa=0.8");
      const end = second!.args.indexOf("/project/.frameshell/cache/clips/bbbb.mp4");
      expect(end).toBeGreaterThan(0);
      expect(second!.args.slice(0, end)).not.toContain("libvpx-vp9");
    });

    it("counts generated clips in the timeline length; they add no sound", () => {
      expect(layeredPlan.audio.tracks).toHaveLength(1);
      expect(layeredPlan.audio.tracks[0]!.reduce((sum, item) => sum + item.samples, 0)).toBe(240_000);
    });

    describe("backdrop (ADR 0031, #462)", () => {
      const glass = { blur: 46, saturate: 1.45, dim: 0.55 };
      const withGlass = (clipId: string, backdrop: object): Timeline => ({
        ...layered,
        tracks: layered.tracks.map((track) =>
          track.kind === "video" ? { ...track, clips: track.clips.map((clip) => (clip.id === clipId ? ({ ...clip, backdrop } as Clip) : clip)) } : track,
        ),
      });
      const glassPlan = compileRender({ ...input, timeline: withGlass("c_title", glass) });
      const filters = (plan: typeof glassPlan) => Object.values(plan.files).join("\n");

      it("blurs, saturates and dims what is below a generated clip, masked by its alpha, before the clip (golden)", () => {
        golden("backdrop-plan", {
          segments: glassPlan.segments,
          files: glassPlan.files,
          frame: compileFrame({ ...input, timeline: withGlass("c_title", glass), width: 1280, height: 720, at: 2, output: "/out/frame.png" }),
        });
        const graph = filters(glassPlan);
        expect(graph).toContain("gblur=sigma=46");
        expect(graph).toContain("lutrgb=a='gt(val,8)*255'");
        // The mask fades with the card: it takes the clip's opacity too.
        expect(graph.match(/colorchannelmixer=aa=0\.8/g)).toHaveLength(2);
        expect(glassPlan.warnings).toEqual([]);
      });

      it("scales the sigma with the output, and draws nothing on the bottom track, with a warning", () => {
        const small = compileFrame({ ...input, timeline: withGlass("c_title", glass), width: 960, height: 540, at: 2, output: "/out/frame.png" });
        expect(small.args.join(" ")).toContain("gblur=sigma=23");
        const bottom = compileRender({ ...input, timeline: withGlass("c_end", glass) });
        expect(bottom.files).toEqual(layeredPlan.files);
        expect(bottom.warnings).toEqual(["Clip c_end is on the bottom picture track: nothing is below it, so its backdrop was not drawn."]);
      });

      it("leaves the colour step out when it changes nothing, and a zero blur out", () => {
        const graph = filters(compileRender({ ...input, timeline: withGlass("c_title", { blur: 0 }) }));
        expect(graph).toContain("[bb0]format=gbrp,format=rgba[bg0]");
      });
    });
  });

  describe("loop (ADR 0039)", () => {
    const looped = (over: Partial<Parameters<typeof compileRender>[0]> = {}) =>
      compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4, loop: true, ...over });

    /** The shared timeline with every clip passed through `edit`. */
    const editClips = (edit: (clip: Record<string, unknown>) => Record<string, unknown>): Timeline =>
      ({ ...timeline, tracks: timeline.tracks.map((track) => ("clips" in track ? { ...track, clips: track.clips.map((clip) => edit({ ...clip })) } : track)) }) as unknown as Timeline;

    it("fades the first and last 96 samples of the mixed audio with a half sine, nothing else changes (golden)", () => {
      const plan = looped();
      expect(plan.loop).toBe(true);
      expect(plan.warnings).toEqual([]);
      const { loop: _loop, ...rest } = plan;
      expect(rest).toEqual(compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4 }));
      golden("loop-plan", { loop: plan.loop, mux: muxStep(plan, MEASURED, "/out/main.mp4.partial") });
    });

    it("leaves a plan without loop as it was: no field, no fade", () => {
      expect(plan).not.toHaveProperty("loop");
      expect(muxStep(plan, MEASURED, "/out.mp4").args.join(" ")).not.toContain("afade");
    });

    it("sizes the fades from the sample rate and leaves a silent export alone", () => {
      const rate44 = looped({ preset: { ...youtube1080, audio: { ...youtube1080.audio, sampleRate: 44_100 } } });
      const filter = muxStep(rate44, null, "/out.mp4").args.find((arg) => arg.includes("afade"))!;
      expect(filter).toContain("afade=t=in:curve=hsin:nb_samples=88,afade=t=out:curve=hsin:start_sample=352712:nb_samples=88");
      const silent: Timeline = { ...timeline, tracks: [timeline.tracks[0]!] };
      const quiet = new Map([...sources].map(([key, source]) => [key, { ...source, audio: false }]));
      const silentPlan = looped({ timeline: silent, sources: quiet });
      expect(muxStep(silentPlan, null, "/out.mp4").args).toContain("anullsrc=r=48000:cl=stereo,atrim=end_sample=384000[a]");
    });

    it("refuses a cover frame: it replaces frame 0 and breaks the seam", () => {
      expect(() => looped({ cover: { at: 1, layout: null } })).toThrow(expect.objectContaining({ code: ErrorCode.InvalidOperation, data: expect.objectContaining({ field: "loop" }) }));
    });

    it("warns when the output frame rate makes the cycle a fraction of a frame, and not when it is whole", () => {
      const rate = (fps: number) => ({ ...youtube1080, video: { ...youtube1080.video, fps } });
      // 240 frames at 30 fps are 192 at 24 fps: whole.
      expect(looped({ preset: rate(24) }).warnings).toEqual([]);
      const shorter = editClips((clip) => (clip.id === "c_logo" ? { ...clip, out: 1 - 1 / 30 } : clip.id === "c_music" ? { ...clip, out: 8 - 1 / 30 } : clip));
      const warnings = looped({ timeline: shorter, preset: rate(24) }).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/239 frames at 30 fps are 191\.2 frames at 24 fps: the cycle is not whole/);
    });

    it("warns when the first or the last frame is black, naming the frame", () => {
      const fadeIn = editClips((clip) => (clip.id === "c_talk1" ? { ...clip, fadeIn: 0.5 } : clip));
      expect(looped({ timeline: fadeIn }).warnings).toEqual([expect.stringMatching(/^Loop: frame 0 is black \(the first clip fades in from black\), so every pass restarts from black/)]);
      const fadeOut = editClips((clip) => (clip.id === "c_logo" ? { ...clip, fadeOut: 1 } : clip));
      expect(looped({ timeline: fadeOut }).warnings).toEqual([expect.stringMatching(/^Loop: the last frame \(239\) is black \(.*fading in or out\), so every pass ends on black/)]);
    });
  });

  describe("GIF (ADR 0039)", () => {
    const gifPreset = BUILTIN_PRESETS.find((p) => p.id === "gif")!;
    /** What the service passes: the preset's box already fitted to the format (1920x1080 into 1200x1200 is 1200x675). */
    const sized = { ...gifPreset, video: { ...gifPreset.video, ...fitInside(gifPreset.video, resolution) } };
    const gifPlan = (over: Partial<Parameters<typeof compileRender>[0]> = {}) =>
      compileRender({ timeline, fps: 30, preset: sized, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4, ...over });

    it("fits the format inside the preset's box, never up", () => {
      expect(sized.video).toMatchObject({ width: 1200, height: 675 });
      expect(fitInside(gifPreset.video, { width: 1080, height: 1920 })).toEqual({ width: 675, height: 1200 });
      expect(fitInside(gifPreset.video, { width: 1000, height: 1000 })).toEqual({ width: 1000, height: 1000 });
      expect(fitInside(gifPreset.video, { width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
    });

    it("plans lossless RGB segments, a palette pass and a GIF pass, with no audio (golden)", () => {
      const plan = gifPlan();
      expect(plan).toMatchObject({ container: "gif", loop: true, fps: "30/1", width: 1200, height: 675, frames: 240, warnings: [] });
      expect(plan.audio).toEqual({ sampleRate: 48_000, samples: 0, inputs: [], tracks: [], codec: [] });
      expect(mixStep(plan)).toBeNull();
      expect(loudnessAnalysis(plan)).toBeNull();
      golden("gif-plan", { segments: plan.segments, files: plan.files, palette: paletteStep(), gif: gifStep("/out/main.gif.partial") });
    });

    it("caps the frame rate at 30 and keeps 24 and 25", () => {
      const rate = (fps: number) => gifPlan({ preset: { ...sized, video: { ...sized.video, fps } } });
      expect(rate(60).fps).toBe("30/1");
      expect(rate(24).fps).toBe("24/1");
      expect(rate(25).fps).toBe("25/1");
      expect(rate(24).frames).toBe(192);
      expect(gifPlan({ fps: 60 }).fps).toBe("30/1");
    });

    it("refuses more than 350 output frames before rendering, naming the count", () => {
      const long = (frames: number): Timeline => ({
        ...timeline,
        tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_long", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: frames / 30 }] }],
      });
      expect(gifPlan({ timeline: long(350) }).frames).toBe(350);
      expect(() => gifPlan({ timeline: long(351) })).toThrow(expect.objectContaining({ code: ErrorCode.InvalidOperation, data: expect.objectContaining({ frames: 351, max: 350 }) }));
      expect(() => gifPlan({ timeline: long(351) })).toThrow(/at most 350 frames; this timeline would render 351 .*Shorten it to 11\.67 s or less/);
      // The cap counts output frames: 420 frames at 30 fps are 336 at 24 fps.
      const rate24 = { ...sized, video: { ...sized.video, fps: 24 } };
      expect(gifPlan({ timeline: long(420), preset: rate24 }).frames).toBe(336);
    });

    it("has the loop rules without being asked: a cover frame is refused, a black end warns", () => {
      expect(() => gifPlan({ cover: { at: 1, layout: null } })).toThrow(expect.objectContaining({ code: ErrorCode.InvalidOperation, data: expect.objectContaining({ field: "cover" }) }));
      const fadeIn = {
        ...timeline,
        tracks: timeline.tracks.map((track) => (track.id === "v1" && "clips" in track ? { ...track, clips: track.clips.map((clip, i) => (i === 0 ? { ...clip, fadeIn: 0.5 } : clip)) } : track)),
      } as unknown as Timeline;
      expect(gifPlan({ timeline: fadeIn }).warnings).toEqual([expect.stringMatching(/^Loop: frame 0 is black/)]);
    });

    it("leaves quality tiers alone, with the H.264-only warning", () => {
      const plan = gifPlan({ encode: { encoder: "libx264", tier: "draft" } });
      expect(plan.warnings).toEqual(['Quality "draft" only applies to H.264 presets; gif renders as written.']);
      expect(plan.fps).toBe("30/1");
      expect(plan.segments[0]!.args.join(" ")).toContain("-c:v ffv1");
    });
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

  it("plans single frames: in a cut, in a sped-up clip, in a gap and on a still, subtitles burned (golden)", () => {
    const frame = (at: number) =>
      compileFrame({ timeline, fps: 30, sources, resolution, transcripts, width: 1280, height: 720, at, output: "/out/frame.png" });
    golden("frame-plans", { cut: frame(1), speed: frame(3.5), gap: frame(5.5), still: frame(7.5) });
    expect(frame(3.5)).toMatchObject({ frame: 105, at: 3.5, clip: "c_talk2", fonts: ["ArchivoBlack-Regular.ttf"] });
    // At 3.5 s "RÁPIDO" shows: the one frame is moved to its timeline time for the ass filter, laid out at 1280x720.
    const graph = frame(3.5).args[frame(3.5).args.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/,setpts=PTS\+3\.5\/TB,ass=filename=subtitles\.ass:fontsdir=fonts,setpts=PTS-STARTPTS\[v\]$/);
    expect(frame(3.5).files["subtitles.ass"]).toContain("PlayResX: 1280");
    // No cue at 5.5 s: nothing burned.
    expect(frame(5.5)).toMatchObject({ frame: 165, clip: null, files: {}, fonts: [] });
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

  describe("transitions and keys (ADR 0018)", () => {
    /** The fixture sources with probed lengths: media handles after `out` need them. */
    const sized = new Map([...sources].map(([asset, source]) => [asset, source.video?.still ? source : { ...source, duration: 20 }]));
    const animated: Timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 4,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c_talk1", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 6.2, fadeIn: 0.5 },
            // Dissolve from c_talk1's tail; c_talk2's head is a layer over it.
            { id: "c_talk2", type: "media", asset: "assets/talk.mp4", start: 3, in: 10, out: 12, dissolve: 1 },
            // From source 0: no handle before it, so a dip through black.
            { id: "c_talk3", type: "media", asset: "assets/talk.mp4", start: 5, in: 0, out: 1, dissolve: 0.4 },
            // A render's head holds its first frame.
            { id: "c_end", type: "hyperframes", source: "compositions/end/index.html", start: 6, duration: 1, dissolve: 0.5, fadeOut: 0.3 },
          ],
        },
        {
          id: "v2",
          kind: "video",
          clips: [
            { id: "c_logo1", type: "media", asset: "assets/logo.png", start: 0.5, in: 0, out: 2, transform: { scale: 0.3, x: -600, y: -300 } },
            {
              id: "c_logo2",
              type: "media",
              asset: "assets/logo.png",
              start: 2.5,
              in: 0,
              out: 2,
              dissolve: 0.6,
              transform: { y: 200 },
              keys: {
                x: [
                  { at: 0, value: -400, ease: "in-out" },
                  { at: 1.5, value: 400 },
                ],
                scale: [
                  { at: 0.2, value: 0.2, ease: "out" },
                  { at: 1, value: 0.5 },
                ],
                opacity: [
                  { at: 0.5, value: 1, ease: "in" },
                  { at: 1.8, value: 0.3 },
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
              id: "c_music1",
              type: "media",
              asset: "assets/music.wav",
              start: 0,
              in: 0,
              out: 4,
              fadeIn: 1,
              keys: {
                gain: [
                  { at: 1, value: -24, ease: "in-out" },
                  { at: 3, value: -12 },
                ],
              },
            },
            { id: "c_music2", type: "media", asset: "assets/music.wav", start: 4, in: 10, out: 13, dissolve: 2, fadeOut: 1, audio: { gain: -15 } },
          ],
        },
      ],
    };
    const generated = new Map([["c_end", { path: "/project/.frameshell/cache/clips/bbbb.mp4", hasAlpha: false, width: 1920, height: 1080 }]]);
    const input = { timeline: animated, fps: 30, preset: youtube1080, loudness: -17, sources: sized, resolution, generated, segmentSeconds: 2 };
    const animatedPlan = compileRender(input);

    it("compiles dissolves, dips, fades, held render frames, keyed layers and sound envelopes (golden)", () => {
      golden("transitions-plan", {
        segments: animatedPlan.segments,
        files: animatedPlan.files,
        audio: animatedPlan.audio,
        mix: mixStep(animatedPlan),
        frame: compileFrame({ ...input, width: 1280, height: 720, at: 3.1, output: "/out/frame.png" }),
      });
      expect(animatedPlan).toMatchObject({ frames: 210, duration: 7 });
    });

    describe("colour grade (ADR 0031, #384)", () => {
      const warm = { temperature: 0.4, saturation: 1.2 };
      const cold = { temperature: -0.5, lut: "luts/look.cube" };
      const graded: Timeline = {
        ...animated,
        tracks: animated.tracks.map((track) =>
          track.kind === "video"
            ? {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === "c_talk1" ? { ...clip, grade: warm } : clip.id === "c_talk2" || clip.id === "c_logo2" ? { ...clip, grade: cold } : clip,
                ),
              }
            : track,
        ) as Timeline["tracks"],
      };
      const key = (grade: object) => gradeKey(gradeOf({ type: "media", grade } as Clip)!);
      const grades = new Map([
        [key(warm), "grade-warm.cube"],
        [key(cold), "grade-cold.cube"],
      ]);
      const gradedPlan = compileRender({ ...input, timeline: graded, grades });
      const graphs = (plan: { files: Record<string, string> }) => Object.values(plan.files).join("\n");

      it("grades each side of a bottom-track dissolve before the mix, and upper layers before scale and alpha (golden)", () => {
        golden("grade-plan", {
          segments: gradedPlan.segments,
          files: gradedPlan.files,
          frame: compileFrame({ ...input, timeline: graded, grades, width: 1280, height: 720, at: 3.1, output: "/out/frame.png" }),
        });
        const graph = graphs(gradedPlan);
        expect(graph).toContain("format=rgba,lut3d=file=grade-warm.cube:interp=trilinear,scale=1920:1080:force_original_aspect_ratio=decrease");
        // The incoming side of the dissolve is a layer: graded before it is scaled and faded in.
        expect(graph).toMatch(/lut3d=file=grade-cold\.cube:interp=trilinear,setpts=PTS\+[\d.]+\/TB,scale=/);
        expect(gradedPlan.warnings).toEqual(animatedPlan.warnings);
      });

      it("leaves timelines without a grade as they were, and draws a grade without a table ungraded, with a warning", () => {
        expect(compileRender({ ...input, grades })).toEqual(animatedPlan);
        const missing = compileRender({ ...input, timeline: graded, grades: new Map([[key(warm), "grade-warm.cube"]]) });
        expect(graphs(missing)).not.toContain("grade-cold");
        expect(missing.warnings).toEqual([
          "Clip c_talk2 has a colour grade with no table; it was exported ungraded.",
          "Clip c_logo2 has a colour grade with no table; it was exported ungraded.",
          ...animatedPlan.warnings,
        ]);
      });

      it("treats a grade that changes nothing as none", () => {
        const neutral: Timeline = {
          ...animated,
          tracks: animated.tracks.map((track) =>
            track.kind === "video" ? { ...track, clips: track.clips.map((clip) => (clip.id === "c_talk1" ? { ...clip, grade: { exposure: 0, lutMix: 0, lut: "luts/look.cube" } } : clip)) } : track,
          ) as Timeline["tracks"],
        };
        expect(compileRender({ ...input, timeline: neutral }).files).toEqual(animatedPlan.files);
      });
    });

    it("draws an incoming dissolve over the outgoing clip's tail, never an xfade, and concatenates the bottom track around it", () => {
      const graphs = Object.values(animatedPlan.files).join("\n");
      expect(graphs).not.toContain("xfade");
      // c_talk2's head: 0.5 s each side of the cut at 3 s, rising alpha over the extended c_talk1.
      expect(graphs).toContain("fade=t=in:alpha=1:st=2.5:d=1");
      // The dip: c_talk2 fades to black over its last 0.2 s, c_talk3 in from black.
      expect(graphs).toContain("fade=t=out:st=4.8:d=0.2");
      expect(graphs).toContain("fade=t=in:st=5:d=0.2");
      // The render's head (8 frames before 6 s): 7 clones of its first rendered frame, then that frame.
      expect(graphs).toContain("trim=end_frame=1,setpts=PTS-STARTPTS,tpad=start=7:start_mode=clone");
    });

    it("crossfades sound on a second sequence of the track, the outgoing clip read into its handle", () => {
      // v1's sound takes two sequences (c_talk2 dissolves in), a1 two (c_music2 crossfades).
      expect(animatedPlan.audio.tracks).toHaveLength(4);
      const [, , music, crossfade] = animatedPlan.audio.tracks;
      // c_music1 plays 0-5 s: 1 s past its out, the second half of c_music2's 2 s crossfade.
      expect(music![0]).toMatchObject({ kind: "clip", clip: "c_music1", from: 0, to: 240_000, samples: 240_000, gainDb: 0 });
      expect(crossfade!.map((item) => item.kind)).toEqual(["silence", "clip"]);
      expect(crossfade![1]).toMatchObject({ kind: "clip", clip: "c_music2", from: 432_000, gainDb: -15 });
      const graph = mixStep(animatedPlan)!.files["mix.filter"]!;
      expect(graph).toContain("curve=qsin");
      expect(graph).toContain(":eval=frame");
    });

    it("leaves a timeline without transitions or keys compiling exactly as before", () => {
      const plain: Timeline = {
        ...animated,
        tracks: animated.tracks.map((track) =>
          track.kind === "subtitles" || track.kind === "program"
            ? track
            : { ...track, clips: track.clips.map(({ dissolve: _d, fadeIn: _i, fadeOut: _o, keys: _k, ...clip }) => clip as Clip) },
        ),
      };
      const withSizes = compileRender({ ...input, timeline: plain });
      const withoutSizes = compileRender({ ...input, timeline: plain, sources });
      expect(withSizes).toEqual(withoutSizes);
      expect(JSON.stringify(withSizes)).not.toMatch(/qsin|eval=frame|alpha=1|clone/);
    });

    describe("through a nested timeline (ADR 0018 decision 9)", () => {
      // Scene: talk on V1, a logo on V2 from 1 s, music on A1; the window cuts talk's fade in and the logo's fade out.
      const scene: Timeline = {
        schemaVersion: 1,
        id: "scene",
        revision: 1,
        tracks: [
          { id: "v1", kind: "video", clips: [{ id: "c_cam", type: "media", asset: "assets/talk.mp4", start: 0, in: 8, out: 12, fadeIn: 0.5 }] },
          {
            id: "v2",
            kind: "video",
            clips: [{ id: "c_badge", type: "media", asset: "assets/logo.png", start: 1, in: 0, out: 4, fadeOut: 0.5, transform: { x: 500, scale: 0.3 } }],
          },
          { id: "a1", kind: "audio", clips: [{ id: "c_bed", type: "media", asset: "assets/music.wav", start: 0, in: 2, out: 6, audio: { gain: -12 } }] },
        ],
      };
      const resolve = (source: string) => (source === "timelines/scene.json" ? scene : null);
      // Scene seconds 0.5 to 3.5 at 2 s on the base track, dissolving from c_talk1, zooming in, fading out.
      const host: Clip = {
        id: "c_scene",
        type: "timeline",
        source: "timelines/scene.json",
        start: 2,
        in: 0.5,
        duration: 3,
        dissolve: 0.6,
        fadeOut: 0.4,
        keys: {
          scale: [
            { at: 0.5, value: 1, ease: "in-out" },
            { at: 3.5, value: 1.25 },
          ],
          gain: [
            { at: 2, value: 0 },
            { at: 3.5, value: -6 },
          ],
        },
      };
      const hosted = (nested: Clip): Timeline => ({
        schemaVersion: 1,
        id: "main",
        revision: 4,
        tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_talk1", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 5.2 }, nested] }],
      });
      const flat = flattenTimeline(hosted(host), resolve, 30);
      const nestedInput = { ...input, timeline: flat, generated: new Map() };
      const nestedPlan = compileRender(nestedInput);

      it("composes the host's keys and edges into every clip it plays, the window's cuts without fades (golden)", () => {
        golden("nested-transitions-plan", {
          segments: nestedPlan.segments,
          files: nestedPlan.files,
          audio: nestedPlan.audio,
          mix: mixStep(nestedPlan),
          frame: compileFrame({ ...nestedInput, width: 1280, height: 720, at: 2.1, output: "/out/frame.png" }),
        });
        const graphs = Object.values(nestedPlan.files).join("\n");
        // The scene's camera comes in over c_talk1's tail (0.3 s each side of 2 s), keyed: a layer, not concatenated.
        expect(graphs).toContain("fade=t=in:alpha=1:st=1.7:d=0.6");
        // Every layer fades out with the host over its last 0.4 s; the window cut off the camera's and logo's own 0.5 s fades.
        expect(graphs).toContain("fade=t=out:alpha=1:st=4.6:d=0.4");
        expect(graphs).not.toContain("d=0.5");
      });

      it("carries a shaped dissolve into the nested clip's tracks: its own track's first clip and its extra layers (ADR 0030)", () => {
        // The badge starts with the window, so it is on screen while the wipe plays (1.7 to 2.3 s).
        const early: Timeline = {
          ...scene,
          tracks: scene.tracks.map((track) =>
            track.id === "v2" && track.kind === "video" ? { ...track, clips: track.clips.map((clip) => ({ ...clip, start: 0, out: 5 }) as Clip) } : track,
          ),
        };
        const both = (source: string) => (source === "timelines/scene.json" ? early : null);
        const wiped = { ...host, shape: { kind: "wipe" as const, direction: "right" as const } };
        const plan = compileRender({ ...nestedInput, timeline: flattenTimeline(hosted(wiped), both, 30) });
        const plain = compileRender({ ...nestedInput, timeline: flattenTimeline(hosted(host), both, 30) });
        const graphs = Object.values(plan.files).join("\n");
        const mixed = Object.values(plain.files).join("\n");
        // A plain dissolve fades the badge in over the half after the cut; the wipe cuts it instead, as it cuts the camera.
        expect(mixed).toContain("fade=t=in:alpha=1:st=2:d=0.3");
        expect(graphs).not.toContain("fade=t=in:alpha=1:st=2:d=0.3");
        expect(graphs).not.toContain("fade=t=in:alpha=1:st=1.7:d=0.6");
        expect(graphs.match(/geq=/g)?.length).toBeGreaterThanOrEqual(2);
        // The badge's corner moves with its keyed host scale: the mask reads it per frame (`W`, `H`).
        expect(graphs).toContain("a='if(lt(X+floor(960+((500)*(if(lt(T,2)");
        // Sound still crossfades in by the dissolve.
        expect(plan.audio).toEqual(plain.audio);
      });

      it("compiles a nested clip without keys or edges exactly as before, handles recorded or not", () => {
        const plain: Clip = { id: "c_scene", type: "timeline", source: "timelines/scene.json", start: 2, in: 0.5, duration: 3, transform: { scale: 0.5 } };
        const quiet: Timeline = { ...scene, tracks: scene.tracks.map((track) => (track.kind === "subtitles" || track.kind === "program" ? track : { ...track, clips: track.clips.map(({ fadeIn: _i, fadeOut: _o, ...clip }) => clip as Clip) })) };
        const both = (source: string) => (source === "timelines/scene.json" ? quiet : null);
        const playback = compileRender({ ...nestedInput, timeline: flattenTimeline(hosted(plain), both, 30) });
        const loose = compileRender({ ...nestedInput, timeline: flattenTimeline(hosted(plain), both) });
        expect(playback).toEqual(loose);
        expect(JSON.stringify(playback)).not.toMatch(/qsin|eval=frame|alpha=1/);
      });
    });
  });

  describe("shaped transitions (ADR 0030)", () => {
    const sized = new Map([...sources].map(([asset, source]) => [asset, source.video?.still ? source : { ...source, duration: 20 }]));
    /** Three talk clips on v1 with a shaped dissolve into each of the last two, music on a1; 9 s. */
    const shaped = (first: TransitionShape, second: TransitionShape): Timeline => ({
      schemaVersion: 1,
      id: "main",
      revision: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c_talk1", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 6.2 },
            { id: "c_talk2", type: "media", asset: "assets/talk.mp4", start: 3, in: 10, out: 13, dissolve: 1, shape: first },
            // From source 0 after a clip played to the source's end: both edge frames hold.
            { id: "c_talk3", type: "media", asset: "assets/talk.mp4", start: 6, in: 0, out: 3, dissolve: 0.4, shape: second },
          ],
        },
        { id: "a1", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 9 }] },
      ],
    });
    // c_talk2 plays its source to the end (20 s) so c_talk3's push holds its last frame.
    const held = (timeline: Timeline): Timeline => {
      const track = timeline.tracks[0] as ClipTrack;
      return { ...timeline, tracks: [{ ...track, clips: track.clips.map((clip) => (clip.id === "c_talk2" ? { ...clip, in: 17, out: 20 } : clip)) }, timeline.tracks[1]!] };
    };
    const planOf = (timeline: Timeline) => compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources: sized, resolution, segmentSeconds: 2 });

    it("pushes: both pieces are layers moved by overlay offsets, the base black under them, edge frames held past the handles (golden)", () => {
      const plan = planOf(held(shaped({ kind: "push", direction: "left" }, { kind: "push", direction: "up" })));
      golden("shaped-push-plan", { segments: plan.segments, files: plan.files, audio: plan.audio, mix: mixStep(plan) });
      const graphs = Object.values(plan.files).join("\n");
      expect(graphs).not.toContain("geq");
      // No alpha ramp for a shaped head: the shape replaces the mix.
      expect(graphs).not.toContain("alpha=1");
      // c_talk2's tail past 20 s and c_talk3's head before source 0 hold their edge frames (the cut at 6 s is a segment join).
      expect(graphs).toContain("trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop=5:stop_mode=clone");
      expect(graphs).toContain("trim=end_frame=1,setpts=PTS-STARTPTS,tpad=start=5:start_mode=clone");
      // Both pieces travel left 1920 px over c_talk2's dissolve, then up 1080 px over c_talk3's (values: parity test).
      expect(graphs.match(/overlay=x='0\+floor\(-1920\*\(max\(0,min\(1,\(\(2\+t\)-2\.5\)\/1\)\)/g)).toHaveLength(2);
      expect(graphs.match(/:y='0\+floor\(-1080\*\(max\(0,min\(1,\(\(4\+t\)-5\.8\)\/0\.4\)\)/g)).toHaveLength(2);
      expect(plan.frames).toBe(270);
    });

    it("wipes: a geq alpha step on the incoming head only, the outgoing clip concatenated under it (golden)", () => {
      const plan = planOf(shaped({ kind: "wipe", direction: "left" }, { kind: "wipe", direction: "down" }));
      golden("shaped-wipe-plan", { segments: plan.segments, files: plan.files, audio: plan.audio });
      const graphs = Object.values(plan.files).join("\n");
      // c_talk2's head, and c_talk3's in two pieces: the segment join at its cut.
      expect(graphs.match(/geq=/g)).toHaveLength(3);
      expect(graphs).not.toContain("alpha=1");
      expect(graphs).not.toContain("eval=frame");
    });

    it("irises: a geq circle on the incoming head only, centred on the origin, the outgoing clip concatenated under it (golden)", () => {
      const plan = planOf(shaped({ kind: "iris", origin: [0.6, 0.2, 0.8, 0.4] }, { kind: "iris" }));
      golden("shaped-iris-plan", { segments: plan.segments, files: plan.files, audio: plan.audio });
      const graphs = Object.values(plan.files).join("\n");
      expect(graphs.match(/geq=/g)).toHaveLength(3);
      // Centres in output pixels: (0.7, 0.3) of the frame, then the frame's centre.
      expect(graphs).toContain("hypot(X+0+0.5-1344,Y+0+0.5-324)");
      expect(graphs).toContain("hypot(X+0+0.5-960,Y+0+0.5-540)");
      expect(graphs).not.toContain("alpha=1");
      expect(graphs).not.toContain("eval=frame");
    });

    it("zooms: both pieces are scaled layers about the origin's centre, the base black under them, no mask (golden)", () => {
      const plan = planOf(held(shaped({ kind: "zoom", origin: [0.6, 0.2, 0.8, 0.4] }, { kind: "zoom" })));
      golden("shaped-zoom-plan", { segments: plan.segments, files: plan.files, audio: plan.audio });
      const graphs = Object.values(plan.files).join("\n");
      expect(graphs).not.toContain("geq");
      expect(graphs).not.toContain("alpha=1");
      // Each zoom: the outgoing tail and the incoming head are layers scaled per frame, the outgoing one up to 4x (by the 0.2 origin) and 2x by default.
      expect(graphs).toContain("scale=w='max(1,floor(1920*((1+3*(");
      expect(graphs).toContain("scale=w='max(1,floor(1920*((1+1*(");
      expect(graphs).toContain("scale=w='max(1,floor(1920*((max(0,min(1,");
      expect(graphs).toContain("overlay_w/2+0.5)");
    });

    it("slats: a geq alpha of strips on the incoming head only, the outgoing clip concatenated under it (golden)", () => {
      const plan = planOf(shaped({ kind: "slats", direction: "left", count: 6 }, { kind: "slats", direction: "down" }));
      golden("shaped-slats-plan", { segments: plan.segments, files: plan.files, audio: plan.audio });
      const graphs = Object.values(plan.files).join("\n");
      // c_talk2's head, and c_talk3's in two pieces: the segment join at its cut.
      expect(graphs.match(/geq=/g)).toHaveLength(3);
      expect(graphs).toContain("(X+0+0.5)*6/1920");
      expect(graphs).toContain("(Y+0+0.5)*8/1080");
      expect(graphs).not.toContain("eval=frame");
    });

    it("grids: a geq alpha of cells on the incoming head only, square cells in the output frame (golden)", () => {
      const plan = planOf(shaped({ kind: "grid", count: 16 }, { kind: "grid" }));
      golden("shaped-grid-plan", { segments: plan.segments, files: plan.files, audio: plan.audio });
      const graphs = Object.values(plan.files).join("\n");
      expect(graphs.match(/geq=/g)).toHaveLength(3);
      // 16 columns of 120 px: 9 rows of 120 px; 12 columns of 160 px: 7 rows (6.75 rounded).
      expect(graphs).toContain("floor((X+0+0.5)*16/1920)");
      expect(graphs).toContain("floor((Y+0+0.5)*9/1080)");
      expect(graphs).toContain("floor((Y+0+0.5)*7/1080)");
      expect(graphs).not.toContain("eval=frame");
    });

    /** `timeline` with its talk track lifted over a still on a new bottom track. */
    const lifted = (timeline: Timeline): Timeline => ({
      ...timeline,
      tracks: [{ id: "v0", kind: "video", clips: [{ id: "c_bg", type: "media", asset: "assets/logo.png", start: 0, in: 0, out: 9 }] }, ...timeline.tracks],
    });

    it("wipes on an upper track: the incoming head masked, the outgoing tail under the inverse mask, no fades (golden)", () => {
      const plan = planOf(lifted(shaped({ kind: "wipe", direction: "left" }, { kind: "iris", origin: [0.6, 0.2, 0.8, 0.4] })));
      golden("shaped-upper-plan", { segments: plan.segments, files: plan.files });
      const graphs = Object.values(plan.files).join("\n");
      expect(graphs).not.toContain("alpha=1");
      // c_talk2's head shows right of the edge, c_talk1's tail left of it; the alpha a picture has is kept.
      expect(graphs).toContain("a='if(lt(X+0+0.5,1920*(1-(");
      expect(graphs).toMatch(/a='if\(lt\(X\+0\+0\.5,1920\*\(1-\(.*\)\)\),alpha\(X,Y\),0\)'/);
      expect(graphs).toMatch(/a='if\(lt\(X\+0\+0\.5,1920\*\(1-\(.*\)\)\),0,alpha\(X,Y\)\)'/);
      // The iris into c_talk3: its head inside the circle, c_talk2's tail outside it.
      expect(graphs).toMatch(/hypot\(X\+0\+0\.5-1344,Y\+0\+0\.5-324\)[^']*\),alpha\(X,Y\),0\)'/);
      expect(graphs).toMatch(/hypot\(X\+0\+0\.5-1344,Y\+0\+0\.5-324\)[^']*\),0,alpha\(X,Y\)\)'/);
    });

    it("zoom, slats and grid on an upper track: a zoom scales both pieces, the masks cut both, neither fades", () => {
      const zoomed = Object.values(planOf(lifted(shaped({ kind: "zoom" }, { kind: "zoom", origin: [0.1, 0.1, 0.3, 0.3] }))).files).join("\n");
      expect(zoomed).not.toContain("geq");
      expect(zoomed).not.toContain("alpha=1");
      // The outgoing tails and the incoming heads of both zooms are scaled layers.
      expect(zoomed.match(/eval=frame:eof_action/g)!.length).toBeGreaterThanOrEqual(4);
      for (const shape of [{ kind: "slats", count: 5 }, { kind: "grid", count: 10 }] as const) {
        const graphs = Object.values(planOf(lifted(shaped(shape, shape))).files).join("\n");
        expect(graphs).not.toContain("alpha=1");
        // Incoming heads keep the picture where the shape shows it, outgoing tails where it does not; the alpha a picture has is kept.
        expect(graphs).toMatch(/a='if\([^']*,alpha\(X,Y\),0\)'/);
        expect(graphs).toMatch(/a='if\([^']*,0,alpha\(X,Y\)\)'/);
      }
    });

    it("pushes on an upper track: both pieces moved, neither faded", () => {
      const graphs = Object.values(planOf(lifted(shaped({ kind: "push", direction: "right" }, { kind: "push" }))).files).join("\n");
      expect(graphs).not.toContain("geq");
      expect(graphs).not.toContain("alpha=1");
      expect(graphs.match(/x='0\+floor\(1920\*\(/g)?.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("formats (ADR 0027)", () => {
  /** A 16:9 project declaring every built-in format. */
  const project = {
    resolution,
    formats: [
      { id: "16x9", width: 1920, height: 1080 },
      { id: "9x16", width: 1080, height: 1920 },
      { id: "1x1", width: 1080, height: 1080 },
      { id: "4x5", width: 1080, height: 1350 },
    ],
  };
  /** The talk timeline plus an untransformed title and a transformed logo on a second video track. */
  const layered: Timeline = {
    ...timeline,
    tracks: [
      ...timeline.tracks,
      {
        id: "v2",
        kind: "video",
        clips: [
          { id: "c_over", type: "media", asset: "assets/title.webm", start: 1, in: 0, out: 1 },
          { id: "c_logo2", type: "media", asset: "assets/logo.png", start: 4, in: 0, out: 1, transform: { x: 600, y: -300, scale: 0.25 } },
        ],
      },
    ],
  };
  const inFormat = (id: string) => {
    const { format } = resolveFormat(layered, project, id)!;
    const preset = { ...youtube1080, video: { ...youtube1080.video, width: format.width, height: format.height } };
    return compileRender({ timeline: layered, fps: 30, preset, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4, variant: format });
  };

  it("compiles the primary format exactly as without formats", () => {
    const plain = compileRender({ timeline: layered, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, transcripts, segmentSeconds: 4 });
    expect(inFormat("16x9")).toEqual(plain);
  });

  it("crops untransformed footage to fill 9:16, 1:1 and 4:5 around the centre; transformed layers keep their fit (golden)", () => {
    const plans = Object.fromEntries(["9x16", "1x1", "4x5"].map((id) => [id, inFormat(id)]));
    golden("formats-plan", Object.fromEntries(Object.entries(plans).map(([id, plan]) => [id, { width: plan.width, height: plan.height, files: plan.files }])));
    const vertical = plans["9x16"]!.files["seg-0001.filter"]!;
    // 1920x1080 talk: its centre 608x1080 scaled to 1080x1920, no black bars.
    expect(vertical).toContain("crop=608:1080:656:0,scale=1080:1920,setsar=1,format=yuv420p");
    expect(vertical).not.toContain("force_original_aspect_ratio=decrease");
    // The untransformed title on the upper track has alpha (decision 13 of #469): fitted whole, centred, never cropped.
    expect(vertical).toMatch(/\[1:v:0\][^;]*scale=1080:608,setsar=1,format=rgba.*\[o0\]/);
    expect(vertical).toContain("[base][o0]overlay=x=0:y=656");
    // The square: the centre 1080x1080 of the frame at its own size.
    expect(plans["1x1"]!.files["seg-0001.filter"]).toContain("crop=1080:1080:420:0,scale=1080:1080");
    // The transformed logo is still fitted and placed like a 16:9 project's, mapped onto the frame.
    expect(plans["9x16"]!.files["seg-0002.filter"]).toContain("scale=270:270,setsar=1,format=rgba");
  });

  it("fits an alpha overlay on an upper track whole and still covers with an opaque one (decision 13 of #469)", () => {
    const stacked = (asset: string): Timeline => ({
      ...timeline,
      tracks: [timeline.tracks[0]!, { id: "v2", kind: "video", clips: [{ id: "c_up", type: "media", asset, start: 1, in: 0, out: 1 }] }],
    });
    const withSources = new Map<string, ExportSource>([
      ...sources,
      ["assets/b-roll.mp4", { path: "/project/assets/b-roll.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: false }],
      ["assets/frame.png", { path: "/project/assets/frame.png", video: { codec: "png", still: true, width: 1920, height: 1080, alpha: true }, audio: false }],
    ]);
    const graph = (asset: string) => {
      const upper = stacked(asset);
      const { format } = resolveFormat(upper, project, "9x16")!;
      const preset = { ...youtube1080, video: { ...youtube1080.video, width: 1080, height: 1920 } };
      return compileRender({ timeline: upper, fps: 30, preset, loudness: -17, sources: withSources, resolution, segmentSeconds: 4, variant: format }).files["seg-0001.filter"]!;
    };
    for (const alpha of ["assets/title.webm", "assets/frame.png"]) {
      const overlay = graph(alpha).split("\n").find((line) => line.includes("[o0]"))!;
      expect(overlay).toContain("scale=1080:608");
      expect(overlay).not.toContain("crop=");
    }
    // The base track under it is cropped as before.
    expect(graph("assets/title.webm")).toContain("crop=608:1080:656:0,scale=1080:1920,setsar=1,format=yuv420p");
    expect(graph("assets/b-roll.mp4").split("\n").find((line) => line.includes("[o0]"))).toContain("crop=608:1080:656:0,scale=1080:1920");
  });

  it("makes captions 1.3x larger in vertical formats only", () => {
    const fontSize = (plan: ReturnType<typeof compileRender>) => Number(/^Style: t0,[^,]+,([\d.]+),/m.exec(plan.files["subtitles.ass"]!)![1]);
    const square = fontSize(inFormat("1x1"));
    expect(fontSize(inFormat("9x16")) / square).toBeCloseTo(1.3, 1);
    expect(fontSize(inFormat("4x5")) / square).toBeCloseTo(1.3, 1);
    expect(square).toBe(fontSize(inFormat("16x9")));
  });

  it("crops a dissolving clip's head, drawn as a layer, exactly as its body on the bottom track", () => {
    const dissolving: Timeline = {
      ...timeline,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c_a", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 2 },
            { id: "c_b", type: "media", asset: "assets/talk.mp4", start: 2, in: 4, out: 6, dissolve: 0.5 },
          ],
        },
      ],
    };
    const { format } = resolveFormat(dissolving, project, "9x16")!;
    const preset = { ...youtube1080, video: { ...youtube1080.video, width: 1080, height: 1920 } };
    // Probed lengths: c_a's handle after its `out` needs one.
    const sized = new Map([...sources].map(([asset, source]) => [asset, { ...source, duration: 20 }]));
    const graph = Object.values(compileRender({ timeline: dissolving, fps: 30, preset, loudness: -17, sources: sized, resolution, variant: format }).files).join("\n");
    // c_b's head plays over c_a's tail as an overlay, its body joins the base: one crop for both.
    expect(graph).toMatch(/crop=608:1080:656:0,[^;]*scale=1080:1920,setsar=1,format=rgba,fade=t=in:alpha=1[^;]*\[o0\]/);
    expect(graph).toMatch(/crop=608:1080:656:0,scale=1080:1920,setsar=1,format=yuv420p/);
    expect([...new Set(graph.match(/crop=[^,]+/g))]).toEqual(["crop=608:1080:656:0"]);
  });

  it("keeps the sound and captions of a dissolving clip hidden in a format: only its picture goes (ADR 0027 decision 5)", () => {
    const dissolving = (hidden: boolean): Timeline => ({
      ...timeline,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "c_a", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 6.2, ...(hidden ? { formats: { "9x16": { hidden: true } } } : {}) },
            { id: "c_b", type: "media", asset: "assets/talk.mp4", start: 3, in: 10, out: 12, dissolve: 0.5 },
          ],
        },
        { id: "s1", kind: "subtitles", follows: "v1" },
      ],
    });
    const sized = new Map([...sources].map(([asset, source]) => [asset, { ...source, duration: 20 }]));
    const vertical = { ...youtube1080, video: { ...youtube1080.video, width: 1080, height: 1920 } };
    const compile = (stored: Timeline, id: string) => {
      const { timeline: shown, format } = resolveFormat(stored, project, id)!;
      return compileRender({ timeline: shown, fps: 30, preset: id === "9x16" ? vertical : youtube1080, loudness: -17, sources: sized, resolution, transcripts, variant: format });
    };
    const primary = compile(dissolving(true), "16x9");
    const hidden = compile(dissolving(true), "9x16");
    const shown = compile(dissolving(false), "9x16");
    // The crossfade into c_b and c_a's words are the primary's.
    expect(hidden.audio).toEqual(primary.audio);
    expect(mixStep(hidden)!.files).toEqual(mixStep(primary)!.files);
    const cues = (plan: ReturnType<typeof compileRender>) => plan.files["subtitles.ass"]!.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(cues(hidden)).toEqual(cues(shown));
    expect(cues(hidden).some((line) => line.includes("HOLA"))).toBe(true);
    // c_a's picture is gone: only c_b's (head and body) reads the talk.
    const graph = (plan: ReturnType<typeof compileRender>) => Object.entries(plan.files).filter(([name]) => name.endsWith(".filter") && name.startsWith("seg-")).map(([, text]) => text).join("\n");
    expect(graph(hidden).match(/crop=/g)!.length).toBeLessThan(graph(shown).match(/crop=/g)!.length);
  });

  it("crops to even sizes and edges, as ffmpeg cuts a 4:2:0 picture", () => {
    const small: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_s", type: "media", asset: "assets/small.mp4", start: 0, in: 0, out: 1 }] }] };
    const withSmall = new Map<string, ExportSource>([...sources, ["assets/small.mp4", { path: "/project/assets/small.mp4", video: { codec: "h264", still: false, width: 1280, height: 720 }, audio: false }]]);
    const { format } = resolveFormat(small, project, "9x16")!;
    const preset = { ...youtube1080, video: { ...youtube1080.video, width: 1080, height: 1920 } };
    const plan = compileRender({ timeline: small, fps: 30, preset, loudness: -17, sources: withSmall, resolution, variant: format });
    // The centred 405x720 of 1280x720, rounded down to even.
    expect(plan.files["seg-0001.filter"]).toContain("crop=404:720:438:0,scale=1080:1920");
  });

  it("leaves generated renders to their own layout", () => {
    const render = new Map([["c_gen", { path: "/project/.frameshell/cache/clips/cccc.webm", hasAlpha: true, width: 1080, height: 1920 }]]);
    const withRender: Timeline = {
      ...timeline,
      tracks: [timeline.tracks[0]!, { id: "v2", kind: "video", clips: [{ id: "c_gen", type: "hyperframes", source: "compositions/t/index.html", start: 0, duration: 2 }] }],
    };
    const { format } = resolveFormat(withRender, project, "9x16")!;
    const preset = { ...youtube1080, video: { ...youtube1080.video, width: 1080, height: 1920 } };
    const plan = compileRender({ timeline: withRender, fps: 30, preset, loudness: -17, sources, resolution, generated: render, segmentSeconds: 4, variant: format });
    // Rendered at the format's size: fitted as it is, never cropped.
    expect(plan.files["seg-0001.filter"]).toContain("scale=1080:1920,setsar=1,format=rgba");
    expect(plan.files["seg-0001.filter"]).not.toMatch(/crop=[^,]*,scale=1080:1920,setsar=1,format=rgba/);
  });
});

describe("sample-accurate audio fades (#585)", () => {
  const fps = 30;
  const sized = new Map([...sources].map(([asset, source]) => [asset, source.video?.still ? source : { ...source, duration: 20 }]));
  const fades = { fadeInMs: 12, fadeOutMs: 12 };
  // p1 → p2 crossfade (no audio fade at that cut), p3 one frame long (fades clamp to half of it), p4 also fades in from black.
  const phrases: MediaClip[] = [
    { id: "p1", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 1, audio: fades },
    { id: "p2", type: "media", asset: "assets/music.wav", start: 1, in: 2, out: 3, dissolve: 0.2, audio: { ...fades, gain: -6 } },
    { id: "p3", type: "media", asset: "assets/music.wav", start: 4, in: 5, out: 5.033, audio: { fadeInMs: 40, fadeOutMs: 40 } },
    { id: "p4", type: "media", asset: "assets/music.wav", start: 5, in: 6, out: 7, fadeIn: 0.5, audio: { fadeInMs: 12 } },
  ];
  const voice: Timeline = { schemaVersion: 1, id: "main", revision: 3, tracks: [{ id: "a1", kind: "audio", clips: phrases }] };
  const plan = compileRender({ timeline: voice, fps, preset: youtube1080, loudness: -17, sources: sized, resolution, segmentSeconds: 4 });
  const { sampleRate } = plan.audio;
  const at = (seconds: number) => Math.round((Math.round(seconds * fps) / fps) * sampleRate);
  /** Each clip item with its first timeline sample, from every lane (p2 dissolves in on a lane of its own). */
  const items: { item: Extract<AudioItem, { kind: "clip" }>; first: number }[] = [];
  for (const lane of plan.audio.tracks) {
    let cursor = 0;
    for (const item of lane) {
      if (item.kind === "clip") items.push({ item, first: cursor });
      cursor += item.samples;
    }
  }
  const ramps = (id: string) => items.find(({ item }) => item.clip === id)!.item.ramps ?? [];
  /** Product of `afade` ramps (`curve=qsin`) at an item's output sample `n`, as af_afade computes it. */
  const afades = (list: readonly { type: string; start: number; length: number }[], n: number) =>
    list.reduce((p, ramp) => {
      const index = ramp.type === "in" ? n - ramp.start : ramp.start + ramp.length - n;
      return p * Math.sin((Math.min(1, Math.max(0, index / ramp.length)) * Math.PI) / 2);
    }, 1);

  it("writes 12 ms fades as afade sample counts, none at a crossfaded cut, at most half a one-frame clip (golden)", () => {
    golden("audio-fades-plan", { audio: plan.audio, mix: mixStep(plan) });
    // 12 ms at 48 kHz = 576 samples. p1 ends into p2's crossfade and p2 starts in it: no 576 ramp at that cut.
    expect(ramps("p1").filter((ramp) => ramp.length === 576)).toEqual([{ type: "in", start: 0, length: 576 }]);
    expect(ramps("p2").filter((ramp) => ramp.length === 576)).toEqual([{ type: "out", start: items.find(({ item }) => item.clip === "p2")!.item.samples - 576, length: 576 }]);
    // p3: one frame (1600 samples); 40 ms would be 1920, so each fade takes 800.
    expect(ramps("p3")).toEqual([
      { type: "in", start: 0, length: 800 },
      { type: "out", start: 800, length: 800 },
    ]);
    // p4: its 0.5 s fade from black and its 12 ms fade, multiplied.
    expect(ramps("p4")).toEqual([
      { type: "in", start: 0, length: 24_000 },
      { type: "in", start: 0, length: 576 },
    ]);
  });

  it("ramps every sample of the audio fades exactly as audioFadeGain, the preview's evaluator", () => {
    let checked = 0;
    for (const { item, first } of items) {
      const clip = phrases.find((p) => p.id === item.clip)!;
      const shared = audioFades(clip.audio, at(clip.start), at(clip.start + (clip.out - clip.in)), sampleRate, { in: clip.id === "p2", out: clip.id === "p1" });
      // Only the audio fades (40 ms or less): frame fades and crossfades are ADR 0018's, checked elsewhere.
      const own = (item.ramps ?? []).filter((ramp) => ramp.length <= Math.round(0.04 * sampleRate));
      for (let n = 0; n < item.samples; n++) {
        expect(afades(own, n), `${item.clip} sample ${n}`).toBeCloseTo(shared ? audioFadeGain(shared, first + n) : 1, 12);
        checked++;
      }
    }
    expect(checked).toBe(items.reduce((sum, { item }) => sum + item.samples, 0));
  });

  it("leaves a clip without audio fades as it was", () => {
    const plain: Timeline = { ...voice, tracks: [{ id: "a1", kind: "audio", clips: phrases.map(({ audio: _audio, ...clip }) => clip) }] };
    const without = compileRender({ timeline: plain, fps, preset: youtube1080, loudness: -17, sources: sized, resolution, segmentSeconds: 4 });
    expect(without.audio.tracks[0]!.find((item) => item.kind === "clip" && item.clip === "p3")).not.toHaveProperty("ramps");
  });
});

describe("audio effects (ADR 0031)", () => {
  const voice: AudioEffect[] = [...VOICE_CHAIN];
  const hum: AudioEffect[] = [{ kind: "highpass", frequency: 120 }];
  const fx: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 3,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "c_a", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 5.2, audio: { effects: voice } },
          { id: "c_b", type: "media", asset: "assets/talk.mp4", start: 2, in: 10, out: 11.15, speed: 1.15, audio: { gain: -3, effects: voice } },
          { id: "c_dry", type: "media", asset: "assets/talk.mp4", start: 3, in: 20, out: 21 },
        ],
      },
      { id: "a1", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 4, audio: { gain: -18, effects: hum } }] },
    ],
  };
  const audioFx = new Map([
    [bakeRef("assets/talk.mp4", voice), "/project/.frameshell/audio-fx/talk-voice.pcm"],
    [bakeRef("assets/music.wav", hum), "/project/.frameshell/audio-fx/music-hum.pcm"],
  ]);
  const input = { timeline: fx, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 4 };
  const fxPlan = compileRender({ ...input, audioFx });

  it("reads each clip's sound from its bake, one input per asset and chain, raw PCM spread to stereo (golden)", () => {
    golden("audio-fx-plan", { audio: fxPlan.audio, mix: mixStep(fxPlan), warnings: fxPlan.warnings });
    expect(fxPlan.audio.inputs).toEqual(["/project/.frameshell/audio-fx/talk-voice.pcm", "/project/assets/talk.mp4", "/project/.frameshell/audio-fx/music-hum.pcm"]);
    const mix = mixStep(fxPlan)!;
    expect(mix.args.join(" ")).toContain("-f s16le -ar 48000 -ac 1 -i /project/.frameshell/audio-fx/talk-voice.pcm");
    expect(mix.files["mix.filter"]).toContain("[0:a:0]pan=stereo|c0=c0|c1=c0,aresample=48000");
    expect(mix.files["mix.filter"]).toContain("[1:a:0]aresample=48000");
  });

  it("leaves video and the plan of a timeline without effects as they were", () => {
    const dry = compileRender({ ...input, timeline: { ...fx, tracks: fx.tracks.map((track) => stripEffects(track)) } });
    expect(fxPlan.segments).toEqual(dry.segments);
    expect(compileRender({ ...input, timeline: { ...fx, tracks: fx.tracks.map((track) => stripEffects(track)) }, audioFx })).toEqual(dry);
  });

  it("plays a clip whose bake is missing dry, with a warning", () => {
    const partial = compileRender({ ...input, audioFx: new Map([...audioFx].slice(0, 1)) });
    expect(partial.audio.inputs).toContain("/project/assets/music.wav");
    expect(partial.warnings).toEqual(["Clip c_music has audio effects that are not baked; its sound was exported without them."]);
  });
});

describe("subject layers (ADR 0032)", () => {
  const sized = new Map([...sources].map(([asset, source]) => [asset, source.video?.still ? source : { ...source, duration: 20 }]));
  sized.set("assets/broll.mp4", { path: "/project/assets/broll.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: true, duration: 20 });
  const matte = { path: "/project/.frameshell/cache/mattes/talk.mp4", width: 960, height: 540 };
  const talkMatte = () => new Map([["assets/talk.mp4", matte]]);
  /** Talk on v1, cut, then wiped into a second cut; a word on v2 behind v1's person (unless `plate` is false); music on a1. 6 s. */
  const behind = (plate = true): Timeline => ({
    schemaVersion: 1,
    id: "main",
    revision: 2,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "c_talk1", type: "media", asset: "assets/talk.mp4", start: 0, in: 3.2, out: 6.2 },
          { id: "c_talk2", type: "media", asset: "assets/talk.mp4", start: 3, in: 10, out: 13, dissolve: 1, shape: { kind: "wipe", direction: "left" } },
        ],
      },
      {
        id: "v2",
        kind: "video",
        ...(plate ? { behind: "v1" } : {}),
        clips: [{ id: "c_word", type: "media", asset: "assets/logo.png", start: 0.5, in: 0, out: 5, transform: { scale: 0.5 } }],
      },
      { id: "a1", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 6 }] },
    ],
  });
  const flat = (timeline: Timeline) => flattenTimeline(timeline, () => null, 30);
  const planOf = (timeline: Timeline, mattes: ReadonlyMap<string, typeof matte> = talkMatte()) =>
    compileRender({ timeline: flat(timeline), fps: 30, preset: youtube1080, loudness: -17, sources: sized, resolution, mattes, segmentSeconds: 2 });

  it("draws the plate's clips again above the track behind it, alpha from the matte on the same frames, wiping with the plate (golden)", () => {
    const plan = planOf(behind());
    const frame = compileFrame({ timeline: flat(behind()), fps: 30, sources: sized, resolution, mattes: talkMatte(), width: 1280, height: 720, at: 1, output: "/out/frame.png" });
    golden("subject-plan", { segments: plan.segments, files: plan.files, warnings: plan.warnings, frame });
    const first = plan.files["seg-0001.filter"]!;
    // The matte is cut like its plate clip (same seek, speed, fps and trim), its luma scaled to the source picture.
    expect(first).toContain(",extractplanes=y,scale=1920:1080[sm1]");
    expect(first).toContain("[sp1][sm1]alphamerge,scale=1920:1080,setsar=1,format=rgba");
    const args = plan.segments[0]!.args;
    expect(args.filter((arg) => arg === matte.path)).toHaveLength(1);
    expect(args[args.indexOf(matte.path) - 4]).toBe(args[args.lastIndexOf("/project/assets/talk.mp4") - 4]);
    // The subjects wipe with their plates, on the wipe's frames only: the incoming one's mask, as on the base head, and
    // its complement on the outgoing one, which the incoming subject does not cover where it has no person.
    const graphs = Object.values(plan.files).join("\n");
    const wipe = "1920*(1-(max(0,min(1,(T-2.5)/1))*max(0,min(1,(T-2.5)/1))*(3-2*max(0,min(1,(T-2.5)/1))))))";
    expect(graphs.split(`if(lt(X+0+0.5,${wipe},0,alpha(X,Y))'`)).toHaveLength(3);
    expect(graphs.split(`if(lt(X+0+0.5,${wipe},alpha(X,Y),0)'`)).toHaveLength(2);
    expect(graphs.match(/geq=/g)).toHaveLength(3);
    // No sound of its own: the mix is the one without the subject layer.
    expect(plan.audio).toEqual(planOf(behind(false)).audio);
    expect(plan.warnings).toEqual([]);
  });

  it("leaves a subject clip out with a warning when its asset has no matte, and multiplies a plate's own alpha", () => {
    const missing = planOf(behind(), new Map());
    expect(missing.warnings).toEqual(["assets/talk.mp4 has no subject matte (not made): the tracks behind its plate track show in front of it."]);
    expect(missing.segments).toEqual(planOf(behind(false)).segments);

    const titled: Timeline = {
      ...behind(),
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_title", type: "media", asset: "assets/title.webm", start: 0, in: 0, out: 1 }] }, behind().tracks[1]!],
    };
    const alpha = planOf(titled, new Map([["assets/title.webm", matte]]));
    expect(alpha.files["seg-0001.filter"]).toContain(
      ",format=rgba,split[sp1][sk1];\n[sk1]alphaextract[sa1];\n[sa1][sm1]blend=all_mode=multiply[sm1x];\n[sp1][sm1x]alphamerge",
    );
  });

  const talkOn = (extra: Partial<Clip> = {}) => ({ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 8, ...extra }) as Clip;
  const word = (start: number, end: number) => ({ id: "c_word", type: "media", asset: "assets/logo.png", start, in: 0, out: end - start }) as Clip;
  const stacked = (tracks: Timeline["tracks"]): Timeline => ({ schemaVersion: 1, id: "main", revision: 2, tracks });
  /** True when the frame at `at` seconds draws a subject: it reads the matte. */
  const lifted = (timeline: Timeline, at: number) =>
    compileFrame({ timeline: flat(timeline), fps: 30, sources: sized, resolution, mattes: talkMatte(), width: 1280, height: 720, at, output: "/out/frame.png" }).args.includes(
      matte.path,
    );
  /** Per 2 s segment: whether it decodes the matte. */
  const matted = (timeline: Timeline) => planOf(timeline).segments.map((segment) => segment.args.includes(matte.path));

  it("draws the subject only under the track behind its plate, never over a cutaway on a track between them", () => {
    // A talking head on v1, b-roll cutaways on v2 at 1-3 s and 7-8 s, a word on v3 behind v1 at 2-6 s.
    const cutaway = stacked([
      { id: "v1", kind: "video", clips: [talkOn()] },
      {
        id: "v2",
        kind: "video",
        clips: [
          { id: "c_broll1", type: "media", asset: "assets/broll.mp4", start: 1, in: 0, out: 2 },
          { id: "c_broll2", type: "media", asset: "assets/broll.mp4", start: 7, in: 4, out: 5 },
        ],
      },
      { id: "v3", kind: "video", behind: "v1", clips: [word(2, 6)] },
    ]);
    // No word (b-roll or not), and a word over the b-roll, show no person; the word alone has the person in front.
    expect([1.5, 2.5, 4, 5.9, 6.5, 7.5].map((at) => lifted(cutaway, at))).toEqual([false, false, true, true, false, false]);
    // The plate and its matte are decoded twice only where the person is lifted, not over the whole export.
    expect(matted(cutaway)).toEqual([false, true, true, false]);
    expect(planOf(cutaway).warnings).toEqual([
      "Track v2 lies between plate track v1 and track v3, which is behind its subject: while v2 shows a clip there, v3 is drawn in front of the person. " +
        "Move v2 above v3 to keep it in front of both.",
    ]);
  });

  it("draws no subject over a fading plate where nothing is behind it", () => {
    // A talking head fading in and out over 1 s each, a word behind it at 2-4 s only.
    const fading = stacked([
      { id: "v1", kind: "video", clips: [talkOn({ out: 6, fadeIn: 1, fadeOut: 1 })] },
      { id: "v2", kind: "video", behind: "v1", clips: [word(2, 4)] },
    ]);
    expect([0.5, 1.9, 2, 3.9, 4, 5.5].map((at) => lifted(fading, at))).toEqual([false, false, true, true, false, false]);
    expect(matted(fading)).toEqual([false, true, false]);
  });
});

function stripEffects(track: Timeline["tracks"][number]): Timeline["tracks"][number] {
  if (track.kind === "subtitles" || track.kind === "program") return track;
  return {
    ...track,
    clips: track.clips.map((clip) => {
      if (clip.type !== "media" || !clip.audio) return clip;
      const { effects: _effects, ...audio } = (clip as MediaClip).audio!;
      return { ...clip, audio } as Clip;
    }),
  };
}
