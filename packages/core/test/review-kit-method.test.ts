import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import type { AdapterClip } from "@frameshell/schema";
import type { GeneratedSource } from "../src/export/compiler.js";
import { type Daemon, startDaemon } from "../src/index.js";
import { alphaHero } from "../src/review/placement.js";
import { spansOf, speedOf as speedOfSamples } from "../src/review/speed.js";
import { SPEED_ALPHA_WIDTH } from "../src/review/thresholds.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// `review` (#457) cuts sheet and per-clip kit (pop, onion, speed) on a 3 s project at 30 fps: black, white, black clips of
// one 320x240 footage on a 1920x1080 film, cut at 1 s and 2 s. Real ffmpeg.
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let ffmpeg: string;
let clips: string[];

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = join(tempDir(), "steps.mp4");
  ffmpeg = (await mediaTools()).ffmpeg;
  const second = (color: string) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=30:d=1`];
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...second("black"),
    ...second("white"),
    ...["-filter_complex", "concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", footage],
  ]);
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const asset = imported[0]!.asset;
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  const add = async (start: number, from: number) => (await conn.request("clip.add", { cwd: project, track: video, asset, start, in: from, out: from + 1 })).changes.added[0]!;
  clips = [await add(0, 0), await add(1, 1), await add(2, 0)];
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

/** The RpcError a `review` call fails with; null when it succeeds. */
const refused = (params: object) =>
  conn.request("review", { cwd: project, ...params } as never).then(
    () => null,
    (error: unknown) => error as RpcError,
  );

/** Grey level of one pixel of a PNG, through ffmpeg. */
async function grey(png: string, x: number, y: number): Promise<number> {
  const pixel = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", png, "-vf", `crop=1:1:${x}:${y},format=gray`, "-f", "rawvideo", "-"]);
  return pixel[0]!;
}

describe("review: cuts sheet", () => {
  it(
    "shows one row of five frames per cut, named by cut and offset, only when named",
    async () => {
      const result = await conn.request("review", { cwd: project, sheets: ["cuts"] });
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["cuts"]);
      const [sheet] = result.sheets;
      expect(sheet!.columns).toBe(5);
      expect(sheet!.rows).toBe(2);
      expect(sheet!.tiles.map((tile) => tile.frame)).toEqual([24, 27, 30, 33, 36, 54, 57, 60, 63, 66]);
      expect(sheet!.tiles.every((tile) => tile.tag === "cut")).toBe(true);
      expect(sheet!.tiles.slice(0, 5).map((tile) => tile.label)).toEqual(["0.80 cut 1 -0.2", "0.90 cut 1 -0.1", "1.00 cut 1 0", "1.10 cut 1 +0.1", "1.20 cut 1 +0.2"]);
      expect(sheet!.tiles[7]!.label).toBe("2.00 cut 2 0");
      const defaults = await conn.request("review", { cwd: project, sheets: undefined });
      expect(defaults.sheets.some((candidate) => candidate.kind === "cuts")).toBe(false);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: pop", () => {
  it(
    "shows the frame before, the frame, and their difference, which is bright where the picture jumps",
    async () => {
      const result = await conn.request("review", { cwd: project, pop: 1 });
      // The kit alone is a debugging look: no default sheets, no metrics.
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["pop"]);
      expect(result.metrics).toBeNull();
      const [sheet] = result.sheets;
      expect(sheet!.tiles.map((tile) => [tile.frame, tile.tag, tile.label])).toEqual([
        [29, "pop", "0.97 frame before"],
        [30, "pop", "1.00 frame"],
        [30, "pop", "1.00 difference x4"],
      ]);
      const { width, height } = sheet!.tile;
      const centre = (column: number) => grey(sheet!.path, 2 + column * (width + 2) + width / 2, 2 + height / 2);
      expect(await centre(0)).toBeLessThan(40);
      expect(await centre(1)).toBeGreaterThan(200);
      expect(await centre(2)).toBeGreaterThan(200);
      // Outside the footage both frames are the film's black: no difference.
      expect(await grey(sheet!.path, 2 + 2 * (width + 2) + width - 8, 2 + height - 8)).toBeLessThan(16);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "takes a marker, and refuses the first frame and a time past the film",
    async () => {
      await conn.request("marker.add", { cwd: project, timeline: "main", at: 2, label: "back" });
      const marked = await conn.request("review", { cwd: project, pop: "back", sheets: ["phone"] });
      expect(marked.sheets.map((sheet) => sheet.kind)).toEqual(["phone", "pop"]);
      expect(marked.sheets.at(-1)!.tiles.map((tile) => tile.frame)).toEqual([59, 60, 60]);
      for (const pop of [0, 5]) {
        const error = await refused({ pop });
        expect(error).toBeInstanceOf(RpcError);
        expect(error!.code).toBe(ErrorCode.InvalidOperation);
        expect(error!.message).toContain("`pop`");
      }
      expect((await refused({ pop: "nowhere" }))!.code).toBe(ErrorCode.InvalidOperation);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: onion", () => {
  it(
    "blends up to 24 frames of the clip into one image",
    async () => {
      const result = await conn.request("review", { cwd: project, onion: clips[1]! });
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["onion"]);
      const [sheet] = result.sheets;
      expect(existsSync(sheet!.path)).toBe(true);
      expect(sheet!.tiles).toHaveLength(1);
      expect(sheet!.tiles[0]!.tag).toBe("onion");
      expect(sheet!.tiles[0]!.label).toBe(`1.00 onion ${clips[1]} 24 frames to 1.97`);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a clip the timeline does not have, a clip outside the range, and a file",
    async () => {
      const missing = await refused({ onion: "c_nope" });
      expect(missing!.code).toBe(ErrorCode.InvalidOperation);
      expect(missing!.message).toContain("c_nope");
      expect((await refused({ onion: clips[2]!, from: 0, to: 1 }))!.code).toBe(ErrorCode.InvalidOperation);
      const file = await refused({ file: join(project, "nothing.mp4"), speed: clips[0]! });
      expect(file!.code).toBe(ErrorCode.InvalidOperation);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: speed", () => {
  /** Key `x` of the first clip at each `[time, value, ease?]`, after clearing its keys. */
  const keyX = async (keys: [number, number, ("in-out" | "out")?][]) => {
    await conn.request("clip.key", { cwd: project, timeline: "main", clip: clips[0]!, prop: "x", clear: true }).catch(() => undefined);
    for (const [time, value, ease] of keys) await conn.request("clip.key", { cwd: project, timeline: "main", clip: clips[0]!, prop: "x", time, value, ...(ease ? { ease } : {}) });
  };
  const speedOf = async () => {
    const result = await conn.request("review", { cwd: project, speed: clips[0]! });
    expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["speed"]);
    expect(existsSync(result.sheets[0]!.path)).toBe(true);
    return result.metrics!.speed![0]!;
  };

  it(
    "finds one linear stretch in a move keyed with no ease",
    async () => {
      await keyX([
        [0, 0],
        [0.9, 480],
      ]);
      const graph = await speedOf();
      expect(graph.hero).toBe("placement");
      expect(graph.frames).toBe(30);
      expect(graph.samples).toBe(30);
      expect(graph.spans).toHaveLength(1);
      expect(graph.spans[0]!.kind).toBe("linear");
      expect(graph.spans[0]!.speed).toBeCloseTo(480 / 27, 1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "finds nothing in an eased move",
    async () => {
      await keyX([
        [0, 0, "in-out"],
        [0.9, 480],
      ]);
      expect((await speedOf()).spans).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "finds a dead stop where the move holds between two keys",
    async () => {
      await keyX([
        [0, 0],
        [0.3, 240],
        [0.6, 240],
        [0.9, 480],
      ]);
      const stops = (await speedOf()).spans.filter((span) => span.kind === "stop");
      // Frames 9 to 17 show the held position: 0.3 s to the end of frame 17.
      expect(stops).toEqual([{ from: 0.3, to: 0.6, kind: "stop", speed: 0 }]);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: speed of a generated clip's alpha", () => {
  it(
    "follows the alpha of a real render and finds its linear move",
    async () => {
      const dir = tempDir();
      const render = join(dir, "slide.webm");
      // A 320x180 transparent frame with a 60x40 white box moving right 4 px a frame (120 px/s at 30 fps) from x 40.
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "color=c=black@0.0:s=320x180:r=30:d=1,format=yuva420p"],
        ...["-f", "lavfi", "-i", "color=c=white:s=60x40:r=30:d=1,format=yuva420p"],
        ...["-filter_complex", "[0][1]overlay=x='40+120*t':y=70:format=auto,format=yuva420p"],
        ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", render],
      ]);
      const wide = { width: 1920, height: 1080 };
      const source: GeneratedSource = { path: render, hasAlpha: true, width: 320, height: 180 };
      const clip = { id: "title", type: "hyperframes", start: 0, duration: 1 } as unknown as AdapterClip;
      const samples = await alphaHero({ ffmpeg, clip, render: source, film: wide, project: wide, work: join(dir, "work") }, { first: 0, count: 30, step: 1 }, 30, SPEED_ALPHA_WIDTH);
      expect(samples.length).toBeGreaterThan(25);
      // The render fills a film 6 times larger: 24 film px a frame.
      const intervals = speedOfSamples(samples);
      expect(intervals[10]!.speed).toBeCloseTo(24, 0);
      const spans = spansOf(intervals);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.kind).toBe("linear");
    },
    MEDIA_TIMEOUT,
  );
});
