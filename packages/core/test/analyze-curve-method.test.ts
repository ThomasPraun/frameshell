import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYZE_RESULT_LABELS, type AnalyzeResult, type DaemonConnection, connectToDaemon, labelOf, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon, writeFaceScan } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `analyze` curve, ink, mouth sync and labels (#471 slice 3), with real ffmpeg on three 8 s films at 30 fps, 320x180:
//   slide.mp4: a white box slides right with an out ease from 1 s to 3 s, and left with an in ease from 4 s to 6 s;
//   caption.mp4: a gray picture with the outline of a box in the bottom left from 3 s to 6 s;
//   talk.mp4: a tone in bursts, and a "mouth" that flickers in the same bursts 0.2 s later.
const MEDIA_TIMEOUT = 240_000;
const FILM = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "300"];

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
let slide: AnalyzeResult;
let caption: AnalyzeResult;
let talk: AnalyzeResult;
let talkWithoutScan: AnalyzeResult;

/** `between(t,a,b)` terms summed: 1 inside any of `spans` (seconds). */
function inAny(spans: [number, number][], shift = 0): string {
  return spans.map(([from, to]) => `between(t,${from + shift},${to + shift})`).join("+");
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = tempDir();
  const { ffmpeg } = await mediaTools();
  const base = ["-hide_banner", "-loglevel", "error", "-y"];

  const out = "(1-pow(1-clip((t-1)/2,0,1),3))";
  const back = "pow(clip((t-4)/2,0,1),3)";
  await run(ffmpeg, [
    ...base,
    ...["-f", "lavfi", "-i", "color=c=0x101010:s=320x180:r=30:d=8", "-f", "lavfi", "-i", "color=c=white:s=80x80:r=30:d=8"],
    ...["-filter_complex", `[0][1]overlay=x='20+200*${out}-200*${back}':y=50`, ...FILM, join(footage, "slide.mp4")],
  ]);
  await run(ffmpeg, [
    ...base,
    ...["-f", "lavfi", "-i", "color=c=0x606060:s=320x180:r=30:d=8,drawbox=x=20:y=120:w=100:h=50:color=white:t=4:enable='between(t,3,6)'"],
    ...FILM,
    join(footage, "caption.mp4"),
  ]);
  const voice: [number, number][] = [[1, 1.5], [2.4, 3.1], [4.2, 4.6], [5.5, 6.3]];
  await run(ffmpeg, [
    ...base,
    ...["-f", "lavfi", "-i", `color=c=0x404040:s=320x180:r=30:d=8,drawbox=x=144:y=99:w=32:h=20:color=white:t=fill:enable='(${inAny(voice, 0.2)})*lt(mod(n,2),1)'`],
    ...["-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*440*t)*(${inAny(voice)})':s=48000:d=8`],
    ...["-map", "0:v", "-map", "1:a", "-c:a", "aac", ...FILM, join(footage, "talk.mp4")],
  ]);

  slide = await conn.request("analyze", { cwd: project, file: join(footage, "slide.mp4") });
  caption = await conn.request("analyze", { cwd: project, file: join(footage, "caption.mp4") });
  talkWithoutScan = await conn.request("analyze", { cwd: project, file: join(footage, "talk.mp4"), name: "talk-unscanned" });
  // A people scan of the same file, as `people scan` would have cached it: one face the whole film, boxes twice a second.
  const hash = `sha256:${createHash("sha256").update(readFileSync(join(footage, "talk.mp4"))).digest("hex")}`;
  const boxes = Array.from({ length: 17 }, (_, i) => ({ time: i / 2, x: 0.5, y: 0.45, width: 0.4, height: 0.5, score: 0.9 }));
  await writeFaceScan(project, hash, { width: 320, height: 180, samples: 17, tracks: [{ id: "t1", start: 0, end: 8, boxes, embeddings: [] }] });
  talk = await conn.request("analyze", { cwd: project, file: join(footage, "talk.mp4") });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

/** Paths of every leaf value of `value`, arrays as `[i]`. */
function leafPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [path] : value.flatMap((item, i) => leafPaths(item, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? [path] : entries.flatMap(([key, item]) => leafPaths(item, path === "" ? key : `${path}.${key}`));
  }
  return [path];
}

describe("analyze curve", () => {
  it("matches the method's schema and the manifest keeps the new fields", () => {
    for (const result of [slide, caption, talk]) expect(methods.analyze.result.parse(result)).toEqual(result);
    const manifest = JSON.parse(readFileSync(join(slide.dir, "analysis.json"), "utf8")) as AnalyzeResult;
    expect(manifest.curve).toEqual(slide.curve);
    expect(manifest.shots[0]!.ink).toEqual(slide.shots[0]!.ink);
  });

  it("gives the activity over time, 0.1 s a value", () => {
    expect(slide.curve.step).toBe(0.1);
    expect(slide.curve.values).toHaveLength(80);
    const at = (seconds: number) => slide.curve.values[Math.round(seconds * 10)]!;
    // Still before the slide, moving at its start, still while it rests.
    expect(at(0.5)).toBeLessThan(0.5);
    expect(at(1.1)).toBeGreaterThan(2);
    expect(at(3.5)).toBeLessThan(0.5);
    expect(slide.curve.peak).toBeGreaterThan(at(2.5));
  });

  it("finds the two moves, with their ease", () => {
    const [first, second, ...more] = slide.curve.moves;
    expect(more).toEqual([]);
    expect(first!.start).toBeGreaterThanOrEqual(0.95);
    expect(first!.start).toBeLessThanOrEqual(1.1);
    expect(first!.duration).toBeGreaterThan(1);
    expect(first!.ease).toBe("out");
    // An in ease starts so slowly that its first frames are below the level of a still picture.
    expect(second!.start).toBeGreaterThanOrEqual(4.4);
    expect(second!.start).toBeLessThanOrEqual(4.8);
    expect(second!.end).toBeGreaterThan(5.8);
    expect(second!.ease).toBe("in");
    for (const move of [first!, second!]) expect(move.fit!).toBeLessThan(0.5);
  });
});

describe("analyze ink", () => {
  it("measures the share of the picture an outline covers, when and where", () => {
    expect(caption.shots).toHaveLength(1);
    const ink = caption.shots[0]!.ink;
    // The outline, and the cells next to its edges, in the bottom left of the 8 x 6 grid: 6 to 9 of 48 cells, for 3 s of 8.
    expect(ink.peak).toBeGreaterThan(0.1);
    expect(ink.peak).toBeLessThanOrEqual(0.2);
    expect(ink.peakAt!).toBeGreaterThanOrEqual(2.95);
    expect(ink.peakAt!).toBeLessThanOrEqual(3.2);
    expect(ink.mean).toBeGreaterThan(0.03);
    expect(ink.mean).toBeLessThan(0.09);
    expect(ink.region).toMatchObject({ x: 0 });
    expect(ink.region!.y).toBeGreaterThanOrEqual(0.5);
    expect(ink.region!.y + ink.region!.height).toBeCloseTo(1, 2);
    expect(ink.region!.width).toBeGreaterThanOrEqual(0.25);
    expect(ink.region!.width).toBeLessThanOrEqual(0.375);
    expect(caption.ink).toEqual(ink);
  });
});

describe("analyze sync", () => {
  it("skips, with the reason, a file with no cached face scan", () => {
    expect(talkWithoutScan.sync).toMatchObject({ offset: null, confidence: null, track: null });
    expect(talkWithoutScan.sync.reason).toMatch(/face scan/);
    // A skipped sync is `sync.reason`, not a warning: most reference files have no scan.
    expect(talkWithoutScan.warnings.some((warning) => warning.startsWith("sync:"))).toBe(false);
    expect(slide.sync.reason).toMatch(/no sound/);
  });

  it("measures the mouth 0.2 s after the voice from the cached face scan", () => {
    expect(talk.sync.reason).toBeNull();
    expect(talk.sync.track).toBe("t1");
    expect(talk.sync.offset!).toBeGreaterThanOrEqual(0.13);
    expect(talk.sync.offset!).toBeLessThanOrEqual(0.27);
    expect(talk.sync.confidence!).toBeGreaterThan(0.5);
    expect(talk.sync.frames).toBeGreaterThan(200);
    expect(talk.warnings.some((warning) => warning.startsWith("sync:"))).toBe(false);
  });
});

describe("analyze labels", () => {
  it("labels every value of the result, and says what is estimated and what is decided", () => {
    for (const result of [slide, caption, talk]) {
      expect(result.labels).toEqual(ANALYZE_RESULT_LABELS);
      const unlabelled = leafPaths({ ...result, labels: undefined }).filter((path) => path !== "labels" && labelOf(result.labels, path) === null);
      expect(unlabelled).toEqual([]);
    }
    expect(labelOf(talk.labels, "threshold")).toBe("DECISION");
    expect(labelOf(talk.labels, "events[2].region")).toBe("ESTIMATED");
    expect(labelOf(talk.labels, "rhythm.shotLengthCv")).toBe("MEASURED");
    expect(labelOf(talk.labels, "sync.offset")).toBe("ESTIMATED");
  });
});
