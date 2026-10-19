import { join } from "node:path";
import { type ExportPreset, type MulticamGroup, type ShotClip, type Timeline, cropAt, shotLayers } from "@frameshell/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, type ExportSource, compileRender, executeRender } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// 9:16 export of 16:9 cameras (ADR 0016): solo shots cut around each angle's reframe point, which moves over group time.
const MEDIA_TIMEOUT = 180_000;

const keys = [
  { at: 1, x: 0.125, y: 0.5 },
  { at: 3, x: 0.875, y: 0.5 },
];
const group: MulticamGroup = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, reframe: keys },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
  ],
};
/** Plays group seconds 1..4 from timeline 0: the cut moves from the left of Ana's picture to its right in the first two seconds. */
const solo: ShotClip = { id: "c_1", type: "shot", start: 0, in: 1, out: 4, shot: "solo", angles: ["ana"] };
const timeline = (shots: ShotClip[], groups: MulticamGroup[] = [group]): Timeline => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: shots }],
  groups,
});
const video = (width: number, height: number): ExportSource => ({ path: "/project/x.mp4", video: { codec: "h264", still: false, width, height }, audio: true });
const sources = new Map<string, ExportSource>([
  ["assets/ana.mp4", video(1920, 1080)],
  ["assets/ben.mp4", video(1920, 1080)],
]);
const vertical = BUILTIN_PRESETS.find((p) => p.id === "vertical-1080x1920")!;
const youtube = BUILTIN_PRESETS.find((p) => p.id === "youtube-1080p")!;
const resolution = { width: 1920, height: 1080 };

describe("reframed shots in the export plan", () => {
  it("cuts a still point as a plain crop", () => {
    const still: MulticamGroup = { ...group, angles: [{ ...group.angles[0]!, reframe: [{ at: 0, x: 0.25, y: 0.5 }] }, group.angles[1]!] };
    const plan = compileRender({ timeline: timeline([solo], [still]), fps: 30, preset: vertical, loudness: -17, sources, resolution, segmentSeconds: 10 });
    expect(plan.files["seg-0001.filter"]).toContain("crop=608:1080:176:0,scale=1080:1920");
  });

  it("keeps an odd still edge, which chroma subsampling would round down", () => {
    const still: MulticamGroup = { ...group, angles: [{ ...group.angles[0]!, reframe: [{ at: 0, x: 0.31, y: 0.5 }] }, group.angles[1]!] };
    const plan = compileRender({ timeline: timeline([solo], [still]), fps: 30, preset: vertical, loudness: -17, sources, resolution, segmentSeconds: 10 });
    expect(plan.files["seg-0001.filter"]).toContain("crop=608:1080:291:0:exact=1,scale=1080:1920");
  });

  it("moves the crop with an expression of the group second, per segment", () => {
    const plan = compileRender({ timeline: timeline([solo]), fps: 30, preset: vertical, loudness: -17, sources, resolution, segmentSeconds: 1 });
    const first = plan.files["seg-0001.filter"]!;
    expect(first).toContain("crop=w=608:h=1080:x='clip(round(");
    expect(first).toContain(":y=0:exact=1,scale=1080:1920");
    // The second segment starts at timeline 1 = group 2.
    expect(plan.files["seg-0002.filter"]).toContain("(2+t)");
    // Past the last key the point holds: a still expression.
    expect(plan.files["seg-0003.filter"]).toContain("x='clip(round(1680-304),0,1312)'");
  });

  it("leaves a 16:9 export of 16:9 cameras as it was", () => {
    const plan = compileRender({ timeline: timeline([solo]), fps: 30, preset: youtube, loudness: -17, sources, resolution, segmentSeconds: 10 });
    expect(plan.files["seg-0001.filter"]).toContain("crop=1920:1080:0:0,scale=1920:1080");
    expect(plan.files["seg-0001.filter"]).not.toContain("exact=1");
  });
});

describe("reframed shots rendered (real ffmpeg)", () => {
  /** 9:16 at the smallest even size whose crop of a 128x72 picture is easy to follow. */
  const TALL: ExportPreset = {
    id: "tall",
    container: "mp4",
    video: { codec: "h264", width: 36, height: 64, crf: 12 },
    audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
  };
  let dir: string;
  let ffmpeg: string;
  let real: Map<string, ExportSource>;

  beforeAll(async () => {
    dir = tempDir();
    ({ ffmpeg } = await mediaTools());
    // Four 32 px bands across a 128x72 picture: red, green, blue, green.
    const path = join(dir, "ana.mp4");
    const bands = ["red", "green", "blue", "green"];
    await run(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...bands.flatMap((color) => ["-f", "lavfi", "-i", `color=c=${color}:s=32x72:r=30:d=5`]),
      ...["-f", "lavfi", "-i", "sine=f=220:r=48000:d=5"],
      ...["-filter_complex", "[0:v][1:v][2:v][3:v]hstack=inputs=4[v]", "-map", "[v]", "-map", "4:a"],
      ...["-c:v", "libx264", "-crf", "8", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path],
    ]);
    const source: ExportSource = { path, video: { codec: "h264", still: false, width: 128, height: 72 }, audio: true };
    real = new Map([
      ["assets/ana.mp4", source],
      ["assets/ben.mp4", source],
    ]);
  }, MEDIA_TIMEOUT);

  const classify = ([r = 0, g = 0, b = 0]: number[]) =>
    r > 150 && g < 100 && b < 100 ? "r" : g > 100 && r < 100 && b < 100 ? "g" : b > 150 && r < 100 && g < 100 ? "b" : "?";

  it(
    "follows the keys frame by frame, across segments, as the shared layout says",
    async () => {
      const plan = compileRender({ timeline: timeline([solo]), fps: 30, preset: TALL, loudness: -17, sources: real, resolution: { width: 64, height: 36 }, segmentSeconds: 1 });
      const output = join(dir, "tall.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work"), output });
      const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      const size = 36 * 64 * 3;
      expect(raw.length / size).toBe(90);
      const pixel = (frame: number, x: number) => {
        const at = frame * size + (32 * 36 + x) * 3;
        return classify([...raw.subarray(at, at + 3)]);
      };
      // Which band the layout puts under an output column at a frame, from the same functions the preview uses.
      const expected = (frame: number, x: number) => {
        const [layer] = shotLayers(solo, group, { width: 36, height: 64 }, () => ({ width: 128, height: 72 }), solo.in + frame / 30);
        const crop = layer!.reframe ? cropAt(layer!.reframe, solo.in + frame / 30) : layer!.crop;
        const column = crop.left + ((x + 0.5) * crop.width) / 36;
        return ["r", "g", "b", "g"][Math.floor(column / 32)];
      };
      expect(pixel(0, 18)).toBe("r");
      expect(pixel(89, 18)).toBe("g");
      for (const [frame, x] of [
        [0, 18],
        [15, 18],
        [30, 4],
        [30, 32],
        [45, 18],
        [70, 18],
      ] as const) {
        expect(pixel(frame, x), `frame ${frame} column ${x}`).toBe(expected(frame, x));
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "cuts a still key at an odd left edge where the shared layout puts it",
    async () => {
      // 128x64 at 36x64 out: the crop is 36 wide, scaled 1:1. White columns 0..32, black from 33.
      const path = join(dir, "edge.mp4");
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "color=c=white:s=128x64:r=30:d=2,format=rgb24,drawbox=x=33:y=0:w=95:h=64:color=black:t=fill"],
        ...["-f", "lavfi", "-i", "sine=f=220:r=48000:d=2"],
        ...["-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path],
      ]);
      const source: ExportSource = { path, video: { codec: "h264", still: false, width: 128, height: 64 }, audio: true };
      const edge = new Map([
        ["assets/ana.mp4", source],
        ["assets/ben.mp4", source],
      ]);
      const still: MulticamGroup = { ...group, angles: [{ ...group.angles[0]!, reframe: [{ at: 0, x: 19 / 128, y: 0.5 }] }, group.angles[1]!] };
      const shot: ShotClip = { ...solo, in: 0, out: 1 };
      const [layer] = shotLayers(shot, still, { width: 36, height: 64 }, () => ({ width: 128, height: 64 }), 0);
      expect(layer!.reframe).toBeUndefined();
      expect(layer!.crop).toEqual({ left: 1, top: 0, width: 36, height: 64 });
      const plan = compileRender({ timeline: timeline([shot], [still]), fps: 30, preset: TALL, loudness: -17, sources: edge, resolution: { width: 64, height: 36 }, segmentSeconds: 10 });
      const output = join(dir, "edge-out.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-edge"), output });
      const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      const luma = (x: number) => raw[32 * 36 + x]!;
      // Source column 32 (white) lands on output column 31 and 33 (black) on 32; an even edge would move both one right.
      expect(luma(31)).toBeGreaterThan(160);
      expect(luma(32)).toBeLessThan(96);
    },
    MEDIA_TIMEOUT,
  );
});
