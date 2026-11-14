import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon, methods } from "@frameshell/protocol";
import { type Grade, type Timeline, applyGradeTable, gradeTable, normalizeGrade } from "@frameshell/schema";
import { type Daemon, GRADE_SUGGEST, type FrameLevels, correctionFlags, meanLevels, parseSignalstats, startDaemon, suggestGrade } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `grade.analyze` (#384, ADR 0031): the pure numbers (parse, mean, suggestion), then the method through a real daemon and the
// managed ffmpeg on synthetic ramps whose levels are known.
const MEDIA_TIMEOUT = 240_000;

/** `signalstats` text of one 8-bit video-level frame: every statistic given. */
function statsText(values: Record<string, number>): string {
  return ["frame:0    pts:0       pts_time:0", ...Object.entries(values).map(([key, value]) => `lavfi.signalstats.${key}=${value}`)].join("\n");
}

/** Levels of a neutral picture of the given luma figures. */
function levelsOf(over: Partial<FrameLevels> = {}): FrameLevels {
  return { lumaMin: 0.05, lumaLow: 0.2, lumaMean: 0.45, lumaHigh: 0.75, lumaMax: 0.95, saturation: 0.15, warmth: 0, tint: 0, ...over };
}

describe("signalstats levels", () => {
  const grey = { YMIN: 16, YLOW: 16, YAVG: 125.5, YHIGH: 235, YMAX: 235, UAVG: 128, VAVG: 128, SATAVG: 0 };

  it("normalizes video levels: studio black reads 0, studio white 1, neutral chroma no cast", () => {
    const levels = parseSignalstats(statsText(grey))!;
    expect(levels).toMatchObject({ lumaMin: 0, lumaLow: 0, lumaHigh: 1, lumaMax: 1, saturation: 0 });
    expect(levels.lumaMean).toBeCloseTo(0.5, 6);
    expect(levels.warmth).toBeCloseTo(0, 9);
    expect(levels.tint).toBeCloseTo(0, 9);
  });

  it("reads a red-leaning chroma as warm and a green-leaning one as green", () => {
    const warm = parseSignalstats(statsText({ ...grey, UAVG: 107, VAVG: 157, SATAVG: 35 }))!;
    expect(warm.warmth).toBeGreaterThan(0.1);
    expect(warm.saturation).toBeCloseTo(35 / 224, 6);
    // Both colour differences negative: green is what is left over.
    expect(parseSignalstats(statsText({ ...grey, UAVG: 118, VAVG: 118 }))!.tint).toBeGreaterThan(0.05);
  });

  it("takes the first frame of several, and null for text with none or missing statistics", () => {
    const two = `${statsText(grey)}\n${statsText({ ...grey, YAVG: 200 })}`;
    expect(parseSignalstats(two)!.lumaMean).toBeCloseTo(0.5, 6);
    expect(parseSignalstats("")).toBeNull();
    expect(parseSignalstats(statsText({ YMIN: 16 }))).toBeNull();
  });

  it("averages frames: means for the figures, extremes for min and max", () => {
    const mean = meanLevels([levelsOf({ lumaMin: 0.1, lumaMean: 0.3, lumaMax: 0.8 }), levelsOf({ lumaMin: 0.02, lumaMean: 0.5, lumaMax: 0.97 })]);
    expect(mean).toMatchObject({ lumaMin: 0.02, lumaMax: 0.97 });
    expect(mean.lumaMean).toBeCloseTo(0.4, 9);
  });
});

describe("suggestGrade", () => {
  it("suggests nothing for a picture on target, and says so", () => {
    const { correction, reasons } = suggestGrade(levelsOf({ lumaLow: 0.17, lumaHigh: 0.72 }));
    expect(correction).toEqual({});
    expect(reasons).toEqual(["The picture is within the targets: no correction suggested."]);
    expect(correctionFlags(correction)).toBe("");
  });

  it("lifts a dark picture, within one stop and under the highlight ceiling", () => {
    const dark = suggestGrade(levelsOf({ lumaMean: 0.2, lumaLow: 0.05, lumaHigh: 0.4 })).correction;
    expect(dark.exposure).toBe(1);
    // The same mean with highlights already high: the ceiling holds the lift back.
    const bright = suggestGrade(levelsOf({ lumaMean: 0.3, lumaLow: 0.1, lumaHigh: 0.85 })).correction;
    expect(bright.exposure).toBeGreaterThan(0);
    expect(0.85 * 2 ** (bright.exposure! / GRADE_SUGGEST.gamma)).toBeLessThanOrEqual(GRADE_SUGGEST.highlightCeiling + 0.01);
    // Highlights above the ceiling already: no lift at all.
    expect(suggestGrade(levelsOf({ lumaMean: 0.3, lumaLow: 0.1, lumaHigh: 0.95 })).correction.exposure).toBeUndefined();
  });

  it("darkens a bright picture by at most one stop", () => {
    expect(suggestGrade(levelsOf({ lumaMean: 0.85, lumaLow: 0.5, lumaHigh: 0.97 })).correction.exposure).toBe(-1);
    expect(suggestGrade(levelsOf({ lumaMean: 0.55, lumaLow: 0.3, lumaHigh: 0.85 })).correction.exposure).toBeLessThan(0);
  });

  it("stretches a flat picture and relaxes a harsh one, inside 0.8 to 1.25, never clipping the ends", () => {
    expect(suggestGrade(levelsOf({ lumaLow: 0.35, lumaHigh: 0.55 })).correction.contrast).toBe(1.25);
    expect(suggestGrade(levelsOf({ lumaLow: 0.05, lumaHigh: 0.9 })).correction.contrast).toBe(0.8);
    // Highlights at 0.9 about 0.5: a stretch past (0.97 - 0.5) / 0.4 = 1.175 would clip them.
    const held = suggestGrade(levelsOf({ lumaLow: 0.52, lumaHigh: 0.9 })).correction.contrast;
    expect(held).toBeLessThanOrEqual(1.18);
  });

  it("corrects a warm and a green cast against the grade's own white balance, in part and within 0.4", () => {
    const grey = [150, 150, 150] as const;
    const warm = [166, 150, 134] as const;
    const mean = (pixel: readonly number[]) => (0.2126 * pixel[0]! + 0.7152 * pixel[1]! + 0.0722 * pixel[2]!) / 255;
    // Levels of a flat colour from its RGB, as the converted picture would measure.
    const levels = (pixel: readonly number[]): FrameLevels => ({
      ...levelsOf({ lumaMean: mean(pixel), saturation: 0.15 }),
      warmth: (pixel[0]! - pixel[2]!) / 255,
      tint: (pixel[1]! - (pixel[0]! + pixel[2]!) / 2) / 255,
    });
    expect(levels(grey).warmth).toBe(0);
    const { temperature } = suggestGrade(levels(warm)).correction;
    expect(temperature).toBeLessThan(0);
    expect(Math.abs(temperature!)).toBeLessThanOrEqual(GRADE_SUGGEST.maxCast);
    // Through the real grade table: the cast shrinks, and is not overshot.
    const table = gradeTable(normalizeGrade({ temperature }), null);
    const out = applyGradeTable(table, warm);
    expect(Math.abs(out[0] - out[2])).toBeLessThan(warm[0] - warm[2]);
    expect(out[0]).toBeGreaterThanOrEqual(out[2]);

    const green = [140, 166, 140] as const;
    const { tint } = suggestGrade(levels(green)).correction;
    expect(tint).toBeGreaterThan(0);
    const fixed = applyGradeTable(gradeTable(normalizeGrade({ tint }), null), green);
    expect(fixed[1] - (fixed[0] + fixed[2]) / 2).toBeLessThan(green[1] - (green[0] + green[2]) / 2);
    expect(fixed[1]).toBeGreaterThanOrEqual((fixed[0] + fixed[2]) / 2 - 1);
  });

  it("leaves a cast under about 4 of 255 alone: the controls move the picture far less than their units", () => {
    const { correction } = suggestGrade(levelsOf({ warmth: 0.012, tint: -0.014 }));
    expect(correction.temperature).toBeUndefined();
    expect(correction.tint).toBeUndefined();
  });

  it("moves saturation towards the usual strength, leaves a monochrome picture alone", () => {
    expect(suggestGrade(levelsOf({ saturation: 0.05 })).correction.saturation).toBe(1.2);
    expect(suggestGrade(levelsOf({ saturation: 0.4 })).correction.saturation).toBe(0.85);
    expect(suggestGrade(levelsOf({ saturation: 0.01 })).correction.saturation).toBeUndefined();
    expect(suggestGrade(levelsOf({ saturation: 0.16 })).correction.saturation).toBeUndefined();
  });

  it("gives no suggestion for black or one flat colour", () => {
    for (const flat of [levelsOf({ lumaMean: 0, lumaLow: 0, lumaHigh: 0 }), levelsOf({ lumaLow: 0.45, lumaHigh: 0.46 })]) {
      const { correction, reasons } = suggestGrade(flat);
      expect(correction).toEqual({});
      expect(reasons[0]).toMatch(/no range/);
    }
  });

  it("writes flags in the grade's order, negative numbers with =", () => {
    expect(correctionFlags({ saturation: 1.1, exposure: -0.4, temperature: 0.2, contrast: 1.05 })).toBe("--grade-exposure=-0.4 --grade-temperature 0.2 --grade-contrast 1.05 --grade-saturation 1.1");
  });

  it("only suggests numbers `clip.set` accepts", () => {
    const grade = methods["clip.set"].params.shape.grade;
    for (const levels of [levelsOf({ lumaMean: 0.05, lumaLow: 0.01, lumaHigh: 0.2, warmth: 0.4, tint: -0.3, saturation: 0.03 }), levelsOf({ lumaMean: 0.9, lumaLow: 0.8, lumaHigh: 0.99, warmth: -0.5, tint: 0.4, saturation: 0.9 })]) {
      expect(grade.safeParse(suggestGrade(levels).correction).success).toBe(true);
    }
  });
});

describe("grade.analyze", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;
  let track: string;
  let audioTrack: string;

  /** A 160x90 clip or still whose every row is a ramp: `r`, `g` and `b` are expressions of X (0 to W) in 0 to 255. */
  async function makeRamp(path: string, ramp: { r: string; g: string; b: string }, options: { still?: boolean; durationS?: number; extra?: string } = {}): Promise<void> {
    const { ffmpeg } = await mediaTools();
    const source = `nullsrc=s=160x90:r=10:d=${options.durationS ?? 4},format=gbrp,geq=r='${ramp.r}':g='${ramp.g}':b='${ramp.b}'${options.extra ?? ""}`;
    await run(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source],
      ...(options.still ? ["-frames:v", "1", path] : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", path]),
    ]);
  }

  const read = async (): Promise<Timeline> => JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
  async function addClip(asset: string, start: number, extra: Record<string, unknown> = {}, onTrack = track): Promise<string> {
    const added = await conn.request("clip.add", { cwd: project, track: onTrack, asset, start, ...extra });
    return added.changes.added[0]!;
  }

  beforeAll(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    const footage = tempDir();
    // Neutral ramp 28 to 203: mean level 0.45, spread 0.55, no colour: on every target.
    await makeRamp(join(footage, "neutral.mp4"), { r: "28+X*175/W", g: "28+X*175/W", b: "28+X*175/W" });
    // Dark, warm and thin ramp.
    await makeRamp(join(footage, "dark-warm.mp4"), { r: "30+X*80/W", g: "24+X*60/W", b: "14+X*40/W" });
    // Bright and flat, tagged LOG by its name.
    await makeRamp(join(footage, "Reel_slog3.mp4"), { r: "150+X*60/W", g: "150+X*60/W", b: "150+X*60/W" });
    // A ramp that brightens over time: the first half dark, the second bright.
    await makeRamp(join(footage, "fade.mp4"), { r: "20+X*60/W+if(gte(T,2),120,0)", g: "20+X*60/W+if(gte(T,2),120,0)", b: "20+X*60/W+if(gte(T,2),120,0)" });
    await makeRamp(join(footage, "photo.png"), { r: "30+X*80/W", g: "24+X*60/W", b: "14+X*40/W" }, { still: true });
    await conn.request("asset.import", { cwd: project, files: ["neutral.mp4", "dark-warm.mp4", "Reel_slog3.mp4", "fade.mp4", "photo.png"].map((name) => join(footage, name)) });
    track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    audioTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  }, MEDIA_TIMEOUT);

  afterAll(async () => {
    conn.close();
    await daemon.close();
  });

  it(
    "measures a neutral on-target ramp and suggests nothing",
    async () => {
      const clip = await addClip("assets/neutral.mp4", 0);
      const result = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip });
      expect(methods["grade.analyze"].result.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ clip, asset: "assets/neutral.mp4", mode: "range", from: 0, to: 4, frames: 8, current: null, flags: "", view: "current" });
      expect(result.levels.luma.mean).toBeCloseTo(0.45, 1);
      expect(Math.abs(result.levels.warmth)).toBeLessThan(0.01);
      expect(result.levels.saturation).toBeLessThan(0.01);
      expect(result.suggestion).toEqual({});
      expect(result.samples.map((sample) => sample.at)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "suggests lifting, cooling and stretching a dark warm clip, in grade fields, and applies nothing",
    async () => {
      const clip = await addClip("assets/dark-warm.mp4", 10);
      const before = await read();
      const result = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, samples: 3 });
      expect(result.frames).toBe(3);
      expect(result.levels.luma.mean).toBeLessThan(0.3);
      expect(result.levels.warmth).toBeGreaterThan(0.05);
      expect(result.suggestion.exposure).toBeGreaterThan(0);
      expect(result.suggestion.temperature).toBeLessThan(0);
      expect(result.suggestion.contrast).toBeGreaterThan(1);
      // The ramp has no green cast: a tint of 0.006 measured is under the deadband.
      expect(result.suggestion.tint).toBeUndefined();
      const parsed = methods["clip.set"].params.shape.grade.safeParse(result.suggestion);
      expect(parsed.success).toBe(true);
      expect(result.flags).toContain(`--grade-exposure ${result.suggestion.exposure}`);
      expect(result.flags).toContain(`--grade-temperature=${result.suggestion.temperature}`);
      expect(result.reasons.length).toBe(Object.keys(result.suggestion).length);
      // Read only: the timeline file and its revision are as they were.
      expect(await read()).toEqual(before);
      // Applying it does what it says: the corrected clip measures nearer the target, since the analysis is of the source.
      await conn.request("clip.set", { cwd: project, clip, grade: result.suggestion as Grade });
      const again = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, samples: 3 });
      expect(again.levels).toEqual(result.levels);
      expect(again.current).toEqual(result.suggestion);
      expect(again.warnings.join(" ")).toMatch(/already has a grade/);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "measures one frame with at, in timeline seconds through the clip's in and speed",
    async () => {
      // fade.mp4 is dark for 2 s and bright after. Played from source second 1 at speed 2, from timeline second 20:
      // the source second 2 is at timeline second 20.5.
      const clip = await addClip("assets/fade.mp4", 20, { in: 1, out: 4, speed: 2 });
      const dark = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, at: 20.25 });
      const bright = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, at: 20.75 });
      expect(dark).toMatchObject({ mode: "frame", from: 20.25, to: 20.25, frames: 1 });
      expect(dark.levels.luma.mean).toBeLessThan(0.3);
      expect(bright.levels.luma.mean).toBeGreaterThan(0.6);
      // The whole clip sees both halves.
      const whole = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, samples: 6 });
      const means = whole.samples.map((sample) => sample.luma);
      expect(Math.min(...means)).toBeLessThan(0.3);
      expect(Math.max(...means)).toBeGreaterThan(0.6);
      expect(whole).toMatchObject({ from: 20, to: 21.5 });
      // A range inside the clip: only the bright part.
      const late = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, from: 20.5, to: 21.5, samples: 4 });
      expect(late.levels.luma.low).toBeGreaterThan(0.5);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "measures a still as one frame",
    async () => {
      const clip = await addClip("assets/photo.png", 30, { duration: 3 });
      const result = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, samples: 8 });
      expect(result).toMatchObject({ mode: "frame", frames: 1, asset: "assets/photo.png" });
      expect(result.levels.warmth).toBeGreaterThan(0.05);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "warns that footage named like LOG is flat by design, and keeps the suggestion",
    async () => {
      const clip = await addClip("assets/Reel_slog3.mp4", 40);
      const result = await conn.request("grade.analyze", { cwd: project, timeline: "main", clip, samples: 2 });
      expect(result.warnings.join(" ")).toMatch(/LOG or HDR/);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses what it cannot measure, with the error codes the description names",
    async () => {
      const clip = await addClip("assets/neutral.mp4", 50);
      const fail = async (params: Record<string, unknown>): Promise<RpcError> => {
        try {
          await conn.request("grade.analyze", { cwd: project, timeline: "main", ...params } as never);
        } catch (error) {
          return error as RpcError;
        }
        throw new Error("expected grade.analyze to fail");
      };
      expect((await fail({ clip: "c_nope" })).code).toBe(ErrorCode.ClipNotFound);
      const outside = await fail({ clip, at: 54.5 });
      expect(outside.code).toBe(ErrorCode.InvalidOperation);
      expect((outside.data as { valid: unknown }).valid).toEqual({ from: 50, to: 54 });
      expect((await fail({ clip, from: 49, to: 52 })).code).toBe(ErrorCode.InvalidOperation);
      expect((await fail({ clip, from: 53, to: 52 })).code).toBe(ErrorCode.InvalidOperation);
      expect((await fail({ clip, at: 51, from: 50 })).message).toMatch(/give one/);
      expect((await fail({ clip, samples: 33 })).code).toBe(ErrorCode.InvalidParams);
      // A clip on an audio track is not a picture.
      const sound = await addClip("assets/neutral.mp4", 60, {}, audioTrack).catch(() => null);
      if (sound) expect((await fail({ clip: sound })).code).toBe(ErrorCode.ClipNotFound);
    },
    MEDIA_TIMEOUT,
  );
});
