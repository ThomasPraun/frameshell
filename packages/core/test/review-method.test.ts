import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, REVIEW_KEEP, type ReviewResult, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// The `review` method on a 3 s project (black, white, gray), with real ffmpeg: sheets, labels, motion peaks, file mode.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;

/** Three still seconds, black then white then gray: the picture changes at 1 s (255 levels) and 2 s (about 128). */
async function makeSteps(path: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const second = (color: string) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=30:d=1`];
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...second("black"),
    ...second("white"),
    ...second("0x808080"),
    ...["-filter_complex", "concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
  ]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = join(tempDir(), "steps.mp4");
  await makeSteps(footage);
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  // Two clips of one asset: a cut at 1.5 s.
  await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1.5 });
  await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 1.5, in: 1.5, out: 3 });
  await conn.request("marker.add", { cwd: project, at: 2.4, label: "payoff" });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

function pngSize(path: string): [number, number] {
  const png = readFileSync(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

const near = (value: number, expected: number, tolerance: number) => Math.abs(value - expected) <= tolerance;

describe("review method", () => {
  let result: ReviewResult;

  it(
    "writes the four sheets of a timeline into .frameshell/review/1 and leaves project files alone",
    async () => {
      const before = readFileSync(join(project, "timelines", "main.json"), "utf8");
      const top = readdirSync(project).sort();
      result = await conn.request("review", { cwd: project, timeline: "main" });
      expect(result).toMatchObject({ source: "timeline", timeline: "main", file: null, run: 1, dir: join(project, ".frameshell", "review", "1"), fps: 30, width: 1920, height: 1080 });
      expect(result.range).toEqual({ from: 0, to: 3 });
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["contact", "phone", "motion", "motion", "seam"]);
      for (const sheet of result.sheets) {
        expect(existsSync(sheet.path)).toBe(true);
        expect(pngSize(sheet.path)).toEqual([sheet.width, sheet.height]);
      }
      expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(before);
      expect(readdirSync(project).sort()).toEqual(top);
      const manifest = JSON.parse(readFileSync(join(result.dir, "review.json"), "utf8")) as Record<string, unknown>;
      expect(manifest["run"]).toBe(1);
      expect(manifest["sheets"]).toEqual(result.sheets);
      expect(readdirSync(join(project, ".frameshell", "cache")).includes("review") ? readdirSync(join(project, ".frameshell", "cache", "review")) : []).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it("the contact sheet shows the first and last frame, the cut, the marker and a frame every half second, labelled", () => {
    const contact = result.sheets.find((sheet) => sheet.kind === "contact")!;
    expect(contact).toMatchObject({ columns: 6, tile: { width: 270, height: 152 } });
    const tags = (tag: string) => contact.tiles.filter((tile) => tile.tag === tag).map((tile) => tile.at);
    expect(tags("start")).toEqual([0]);
    expect(tags("end")).toEqual([2.967]);
    expect(tags("cut")).toEqual([1.5]);
    expect(tags("marker")).toEqual([2.4]);
    // 2.5 s is within 0.2 s of the marker at 2.4 s: the marker's frame stands for it.
    expect(tags("grid")).toEqual(expect.arrayContaining([0.5, 1, 2]));
    const cut = contact.tiles.find((tile) => tile.tag === "cut")!;
    expect(cut).toMatchObject({ label: "1.50 cut", frame: 45 });
    expect(contact.tiles.map((tile) => tile.at)).toEqual([...contact.tiles.map((tile) => tile.at)].sort((a, b) => a - b));
    expect(contact.tiles).toHaveLength(7);
    expect(contact.tiles[6]).toMatchObject({ row: 1, column: 0 });
    expect(contact).toMatchObject({ columns: 6, rows: 2 });
  });

  it("the phone sheet is one frame per second, 360 px wide tiles", () => {
    const phone = result.sheets.find((sheet) => sheet.kind === "phone")!;
    expect(phone.tile.width).toBe(360);
    expect(phone.tiles.map((tile) => [tile.at, tile.tag])).toEqual([
      [0, "second"],
      [1, "second"],
      [2, "second"],
    ]);
    expect(phone).toMatchObject({ columns: 3, rows: 1, width: 3 * 362 + 2 });
  });

  it("the strips show the two fastest moments, 12 consecutive frames each, and the peaks say how fast", () => {
    expect(result.peaks).toHaveLength(2);
    expect(near(result.peaks[0]!.at, 1, 0.05)).toBe(true);
    expect(result.peaks[0]!.energy).toBeGreaterThan(150);
    expect(near(result.peaks[1]!.at, 2, 0.05)).toBe(true);
    expect(result.peaks[1]!.energy).toBeGreaterThan(60);
    expect(result.peaks[0]!.energy).toBeGreaterThan(result.peaks[1]!.energy);
    const strips = result.sheets.filter((sheet) => sheet.kind === "motion");
    expect(strips.map((sheet) => sheet.path)).toEqual(result.peaks.map((peak) => peak.strip));
    const first = strips[0]!;
    expect(first.tiles).toHaveLength(12);
    expect(first.tiles.every((tile) => tile.tag === "peak")).toBe(true);
    const frames = first.tiles.map((tile) => tile.frame);
    expect(frames).toEqual(Array.from({ length: 12 }, (_, i) => frames[0]! + i));
    expect(frames).toContain(30);
    expect(first).toMatchObject({ columns: 4, rows: 3, tile: { width: 640, height: 360 } });
  });

  it("the seam sheet is the last 6 frames and the first 6", () => {
    const seam = result.sheets.find((sheet) => sheet.kind === "seam")!;
    expect(seam.tiles.map((tile) => [tile.frame, tile.tag])).toEqual([
      ...[84, 85, 86, 87, 88, 89].map((frame) => [frame, "tail"]),
      ...[0, 1, 2, 3, 4, 5].map((frame) => [frame, "head"]),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it(
    "limits to a range and to the sheets asked for, in the next numbered folder",
    async () => {
      const ranged = await conn.request("review", { cwd: project, from: 0.5, to: 1.5, sheets: ["contact", "seam"], every: 0.25 });
      expect(ranged.run).toBe(2);
      expect(ranged.range).toEqual({ from: 0.5, to: 1.5 });
      expect(ranged.sheets.map((sheet) => sheet.kind)).toEqual(["contact", "seam"]);
      const contact = ranged.sheets[0]!;
      expect(contact.tiles[0]).toMatchObject({ at: 0.5, tag: "start" });
      expect(contact.tiles.at(-1)).toMatchObject({ at: 1.467, tag: "end" });
      expect(contact.tiles.every((tile) => tile.at >= 0.5 && tile.at <= 1.5)).toBe(true);
      expect(ranged.sheets[1]!.tiles[0]).toMatchObject({ frame: 39, tag: "tail" });
      expect(ranged.sheets[1]!.tiles[6]).toMatchObject({ frame: 15, tag: "head" });
      expect(ranged.peaks).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "reviews an exported file the same way: decoded by ffmpeg, grid frames only, peaks found",
    async () => {
      const file = await conn.request("review", { cwd: project, file: footage, sheets: ["contact", "motion"] });
      expect(file).toMatchObject({ source: "file", timeline: null, file: footage, fps: 30, width: 320, height: 240 });
      const contact = file.sheets.find((sheet) => sheet.kind === "contact")!;
      expect(new Set(contact.tiles.map((tile) => tile.tag))).toEqual(new Set(["start", "end", "grid"]));
      expect(file.peaks.length).toBeGreaterThanOrEqual(2);
      expect(near(file.peaks[0]!.at, 1, 0.1)).toBe(true);
      expect(file.peaks[0]!.energy).toBeGreaterThan(150);
      expect(existsSync(file.peaks[0]!.strip!)).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "fails with InvalidOperation outside the film and AssetNotFound for a file that is not there",
    async () => {
      const outside = await conn.request("review", { cwd: project, from: 10, sheets: ["seam"] }).catch((error: unknown) => error);
      expect(outside).toBeInstanceOf(RpcError);
      expect(outside).toMatchObject({ code: ErrorCode.InvalidOperation, data: { valid: { min: 0, max: 2.967 } } });
      const missing = await conn.request("review", { cwd: project, file: join(project, "exports", "nope.mp4") }).catch((error: unknown) => error);
      expect(missing).toMatchObject({ code: ErrorCode.AssetNotFound });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps the newest ten runs",
    async () => {
      for (let i = 0; i < REVIEW_KEEP; i++) await conn.request("review", { cwd: project, from: 0, to: 0.5, sheets: ["seam"] });
      const runs = readdirSync(join(project, ".frameshell", "review")).map(Number).sort((a, b) => a - b);
      expect(runs).toHaveLength(REVIEW_KEEP);
      expect(runs.at(-1)).toBeGreaterThan(REVIEW_KEEP);
    },
    MEDIA_TIMEOUT,
  );
});
