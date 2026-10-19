import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { createProjectConfig, type ExportPreset, type MulticamGroup, type ShotClip, type Timeline, shotLayers } from "@frameshell/schema";
import { BUILTIN_PRESETS, type ExportSource, ExportService, compileFrame, compileRender, executeRender, loudnessAnalysis, mixStep } from "../src/index.js";
import type { JobQueue } from "../src/jobs/queue.js";
import { tempDir } from "./helpers.js";
import { ffprobeJson } from "./media-fixtures.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Multicam shots in export (ADR 0016): the plan is golden, the render is proven by decoding it.
const MEDIA_TIMEOUT = 180_000;
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

const shot = (id: string, start: number, layout: ShotClip["shot"], angles: string[], clipIn = start, out = clipIn + 1): ShotClip => ({
  id,
  type: "shot",
  start,
  in: clipIn,
  out,
  shot: layout,
  angles,
});

/** Ana from group second 0, Ben from 0.5 (his recording started late), Eva at -6 dB. */
const group: MulticamGroup = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.5 },
    { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0, audio: { gain: -6 } },
  ],
};

/** Solo, two-up and grid shots, then Eva and Ben alone. */
const shots: ShotClip[] = [
  shot("c_s1", 0, "solo", ["ana"]),
  shot("c_s2", 1, "two-up", ["ana", "ben"]),
  shot("c_s3", 2, "grid", ["ana", "ben", "eva"]),
  shot("c_s4", 3, "solo", ["eva"]),
  shot("c_s5", 4, "solo", ["ben"]),
];

const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: shots }],
  groups: [group],
};

const source = (name: string, size = { width: 1920, height: 1080 }): [string, ExportSource] => [
  `assets/${name}.mp4`,
  { path: `/project/assets/${name}.mp4`, video: { codec: "h264", still: false, ...size }, audio: true },
];
const sources = new Map<string, ExportSource>([source("ana"), source("ben"), source("eva", { width: 1280, height: 720 })]);
const youtube1080 = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
const resolution = { width: 1920, height: 1080 };

describe("multicam plan", () => {
  const plan = compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources, resolution, segmentSeconds: 2 });

  it("resolves solo, two-up and grid shots into the ffmpeg graph, with every angle's sound (golden)", () => {
    golden("multicam-plan", { plan, mix: mixStep(plan), loudnessAnalysis: loudnessAnalysis(plan) });
  });

  it("lasts as long as the last shot and splits segments on shot edges", () => {
    expect(plan).toMatchObject({ frames: 150, duration: 5, warnings: [] });
    expect(plan.segments.map((s) => [s.from, s.to])).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
  });

  it("mixes every angle under every shot: one audio track per angle, gain applied, Ben delayed by his offset", () => {
    const [ana, ben, eva] = plan.audio.tracks;
    expect(plan.audio.tracks).toHaveLength(3);
    const clips = (items: typeof ana) => items!.filter((item) => item.kind === "clip");
    expect(clips(ana)).toHaveLength(5);
    expect(clips(eva).every((item) => item.kind === "clip" && item.gainDb === -6)).toBe(true);
    // Shot c_s1 plays group 0-1 s: Ben's recording starts at 0.5, so his first clip starts then and reads his 0 s.
    expect(ben![0]).toEqual({ kind: "silence", samples: 24_000 });
    expect(clips(ben)[0]).toMatchObject({ clip: "c_s1/ben", from: 0, samples: 24_000 });
    expect(new Set(plan.audio.inputs)).toEqual(new Set(["/project/assets/ana.mp4", "/project/assets/ben.mp4", "/project/assets/eva.mp4"]));
    for (const track of plan.audio.tracks) expect(track.reduce((sum, item) => sum + item.samples, 0)).toBe(plan.audio.samples);
  });

  it("puts each angle's picture in its tile, cropped to the tile's aspect", () => {
    const filter = plan.files["seg-0002.filter"]!;
    const layers = shotLayers(shots[2]!, group, { width: 1920, height: 1080 }, (asset) => sources.get(asset)!.video!);
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      expect(filter).toContain(`crop=${layer.crop.width}:${layer.crop.height}:${layer.crop.left}:${layer.crop.top},scale=${layer.tile.width}:${layer.tile.height}`);
      expect(filter).toContain(`overlay=x=${layer.tile.left}:y=${layer.tile.top}`);
    }
  });

  it("captures a single frame of a shot", () => {
    const frame = compileFrame({ timeline, fps: 30, at: 2.5, width: 640, height: 360, output: "frame.png", sources, resolution });
    expect(frame).toMatchObject({ frame: 75, at: 2.5, clip: null });
    expect(frame.args.join(" ")).toContain("crop=");
  });

  it("stacks a program track by track order: footage on a later video track covers it", () => {
    const footage = { id: "c_logo", type: "media" as const, asset: "assets/ana.mp4", start: 0, in: 0, out: 1, transform: { scale: 0.5 } };
    const over: Timeline = { ...timeline, tracks: [timeline.tracks[0]!, { id: "v1", kind: "video", clips: [footage] }] };
    const filter = compileRender({ timeline: over, fps: 30, preset: youtube1080, loudness: -17, sources, resolution }).files["seg-0001.filter"]!;
    expect(filter).toContain("[base]");
    expect(filter.indexOf("overlay=x=0:y=0")).toBeLessThan(filter.indexOf("overlay=x=480:y=270"));
  });

  it("warns when an angle has no picture and refuses a program track whose group is missing", () => {
    const audioOnly = new Map(sources).set("assets/ben.mp4", { path: "/project/assets/ben.mp4", video: null, audio: true });
    const warned = compileRender({ timeline, fps: 30, preset: youtube1080, loudness: -17, sources: audioOnly, resolution });
    expect(warned.warnings).toEqual(["Multicam angle g_talk/ben has no picture; its tile stays black."]);
    const orphan: Timeline = { ...timeline, groups: [] };
    expect(() => compileRender({ timeline: orphan, fps: 30, preset: youtube1080, loudness: -17, sources, resolution })).toThrow(
      expect.objectContaining({ code: ErrorCode.ExportUnsupported, message: expect.stringContaining("group g_talk"), data: { timeline: "main", track: "t_p" } }),
    );
  });
});

describe("multicam under a nested timeline", () => {
  const talk: Timeline = { ...timeline, id: "talk" };
  const hosted = (transform?: { scale: number }): Timeline => ({
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_talk", type: "timeline", source: "timelines/talk.json", start: 0, duration: 5, ...(transform ? { transform } : {}) }] }],
  });
  const service = (host: Timeline) => {
    const root = tempDir();
    writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
    const exporter = new ExportService({
      jobs: {} as JobQueue,
      ffmpeg: async () => "ffmpeg",
      probe: async () => ({
        duration: 8,
        format: "mp4",
        video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false },
        audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
      }),
      loadTimeline: async () => ({ timeline: host, fps: 30 }),
      readNested: async (_root, at) => (at === "timelines/talk.json" ? talk : null),
      pluginPresets: async () => [],
    });
    return { root, exporter };
  };

  it("refuses a transformed host clip with a typed error naming the clip and the fix", async () => {
    const { root, exporter } = service(hosted({ scale: 0.5 }));
    await expect(exporter.render(root, { timeline: "main" })).rejects.toMatchObject({
      code: ErrorCode.ExportUnsupported,
      message: expect.stringMatching(/Clip c_talk nests timelines\/talk\.json, which shows multicam shots, and has a transform.*frameshell clip set c_talk/),
      data: { timeline: "main", clip: "c_talk" },
    });
    await expect(exporter.frame(root, { timeline: "main", at: 1, out: join(root, "f.png") })).rejects.toMatchObject({ code: ErrorCode.ExportUnsupported });
  });

  it("plans a host clip without a transform: the nested program track shows over the host's slot", async () => {
    const { root, exporter } = service(hosted());
    // The error that follows comes from the stub queue, after compiling the plan: validation passed.
    await expect(exporter.render(root, { timeline: "main" })).rejects.not.toMatchObject({ code: ErrorCode.ExportUnsupported });
  });
});

describe("multicam render (real ffmpeg)", () => {
  const TINY: ExportPreset = {
    id: "tiny",
    container: "mp4",
    video: { codec: "h264", width: 64, height: 64, crf: 12 },
    audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
  };
  const COLORS = { ana: "red", ben: "green", eva: "blue" } as const;
  const TONES = { ana: 220, ben: 440, eva: 880 } as const;
  let dir: string;
  let ffmpeg: string;
  let real: Map<string, ExportSource>;

  beforeAll(async () => {
    dir = tempDir();
    ({ ffmpeg } = await mediaTools());
    real = new Map();
    for (const name of ["ana", "ben", "eva"] as const) {
      const path = join(dir, `${name}.mp4`);
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", `color=c=${COLORS[name]}:s=64x64:r=30:d=8`],
        ...["-f", "lavfi", "-i", `sine=f=${TONES[name]}:r=48000:d=8`],
        ...["-c:v", "libx264", "-crf", "8", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path],
      ]);
      real.set(`assets/${name}.mp4`, { path, video: { codec: "h264", still: false, width: 64, height: 64 }, audio: true });
    }
  }, MEDIA_TIMEOUT);

  /** The primary a pixel is: r, g, b, or "?". */
  const classify = ([r = 0, g = 0, b = 0]: number[]) =>
    r > 150 && g < 100 && b < 100 ? "r" : g > 100 && r < 100 && b < 100 ? "g" : b > 150 && r < 100 && g < 100 ? "b" : "?";

  async function frames(path: string): Promise<Buffer[]> {
    const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const size = 64 * 64 * 3;
    return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  }
  const pixelAt = (frame: Buffer, x: number, y: number) => [...frame.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];

  it(
    "shows the right angle in every tile of every shot, offsets applied, and plays every angle's sound",
    async () => {
      const plain: MulticamGroup = { ...group, angles: group.angles.map(({ audio: _audio, ...angle }) => angle) };
      const line: Timeline = { ...timeline, groups: [plain] };
      const plan = compileRender({ timeline: line, fps: 30, preset: TINY, loudness: -17, sources: real, resolution: { width: 64, height: 64 }, segmentSeconds: 2 });
      const output = join(dir, "multicam.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work"), output });

      const decoded = await frames(output);
      expect(decoded).toHaveLength(150);
      // Tile centres come from the same function the plan used.
      const centres = (index: number) =>
        shotLayers(shots[index]!, plain, { width: 64, height: 64 }, () => ({ width: 64, height: 64 })).map(
          (layer) => [layer.angle as keyof typeof COLORS, layer.tile.left + Math.floor(layer.tile.width / 2), layer.tile.top + Math.floor(layer.tile.height / 2)] as const,
        );
      const letter = { ana: "r", ben: "g", eva: "b" } as const;
      shots.forEach((_, index) => {
        for (const [angle, x, y] of centres(index)) expect(classify(pixelAt(decoded[index * 30 + 15]!, x, y)), `shot ${index} ${angle}`).toBe(letter[angle]);
      });
      // Cuts are frame exact: the first frame of a shot shows it, the frame before does not.
      expect(classify(pixelAt(decoded[29]!, 32, 32))).toBe("r");
      expect(classify(pixelAt(decoded[30]!, 8, 32))).toBe("r");
      expect(classify(pixelAt(decoded[30]!, 56, 32))).toBe("g");
      expect(classify(pixelAt(decoded[120]!, 32, 32))).toBe("g");
      expect(classify(pixelAt(decoded[119]!, 32, 32))).toBe("b");

      // Sound: three tones under all five seconds, whatever the shot shows.
      const probe = (await ffprobeJson(output, ["-show_entries", "stream=codec_type,duration"])) as { streams: { codec_type: string; duration: string }[] };
      expect(Number(probe.streams.find((s) => s.codec_type === "audio")!.duration)).toBeCloseTo(5, 1);
      const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
      const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
      const power = (hz: number, from: number, to: number) => {
        let re = 0;
        let im = 0;
        for (let i = Math.round(from * 48_000); i < Math.round(to * 48_000); i++) {
          re += samples[i]! * Math.cos((2 * Math.PI * hz * i) / 48_000);
          im += samples[i]! * Math.sin((2 * Math.PI * hz * i) / 48_000);
        }
        return Math.hypot(re, im) / ((to - from) * 48_000);
      };
      // During Eva's solo (3-4 s) all three tones are in the mix, and nothing else.
      const loud = Math.max(...[220, 440, 880].map((hz) => power(hz, 3.2, 3.8)));
      for (const hz of [220, 440, 880]) expect(power(hz, 3.2, 3.8)).toBeGreaterThan(loud / 4);
      expect(power(1000, 3.2, 3.8)).toBeLessThan(loud / 10);
      // Ben's recording starts at 0.5 s of the group: silent before.
      expect(power(440, 0.1, 0.4)).toBeLessThan(loud / 10);
      expect(power(440, 0.7, 1)).toBeGreaterThan(loud / 4);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "starts an angle's picture when its recording starts: before that its tile shows the black base",
    async () => {
      const early: Timeline = {
        ...timeline,
        tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: [shot("c_e", 0, "two-up", ["ana", "ben"], 0, 1.5)] }],
      };
      const plan = compileRender({ timeline: early, fps: 30, preset: TINY, loudness: -17, sources: real, resolution: { width: 64, height: 64 } });
      const output = join(dir, "early.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-early"), output });
      const decoded = await frames(output);
      expect(decoded).toHaveLength(45);
      // Ben (right tile) is black for 0.5 s, then green; Ana is red throughout.
      expect(pixelAt(decoded[5]!, 56, 32).every((v) => v < 40)).toBe(true);
      expect(classify(pixelAt(decoded[20]!, 56, 32))).toBe("g");
      expect(classify(pixelAt(decoded[5]!, 8, 32))).toBe("r");
    },
    MEDIA_TIMEOUT,
  );
});
