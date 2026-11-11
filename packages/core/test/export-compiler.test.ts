import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import {
  type Clip,
  type ClipTrack,
  type Timeline,
  type Transcript,
  type TransitionShape,
  flattenTimeline,
  resolveFormat,
} from "@frameshell/schema";
import {
  BUILTIN_PRESETS,
  type ExportSource,
  assCentiseconds,
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

    it("plays a shaped clip on an upper track as a plain dissolve", () => {
      const timeline = shaped({ kind: "push" }, { kind: "wipe" });
      const lifted: Timeline = { ...timeline, tracks: [{ id: "v0", kind: "video", clips: [{ id: "c_bg", type: "media", asset: "assets/logo.png", start: 0, in: 0, out: 9 }] }, ...timeline.tracks] };
      const graphs = Object.values(planOf(lifted).files).join("\n");
      expect(graphs).not.toContain("geq");
      expect(graphs).toContain("fade=t=in:alpha=1:st=2.5:d=1");
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
