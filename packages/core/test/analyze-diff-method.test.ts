import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYZE_DIFF_LABELS, type AnalyzeDiffResult, type DaemonConnection, ErrorCode, RpcError, connectToDaemon, labelOf, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `analyze.diff` (#471 slice 3), with real ffmpeg on 320x180 films at 30 fps: a white box slides right with an out ease and back
// with an in ease; the same film again a second later; the same motion in negative; and a vertical one.
const MEDIA_TIMEOUT = 240_000;
const FILM = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "300"];

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
let late: AnalyzeDiffResult;
let negative: AnalyzeDiffResult;

/** A box that slides right 1 s to 3 s after `shift` and back 4 s to 6 s after it, on a film of `seconds`. */
async function slideFilm(path: string, shift: number, seconds: number, extra = ""): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const out = `(1-pow(1-clip((t-${1 + shift})/2,0,1),3))`;
  const back = `pow(clip((t-${4 + shift})/2,0,1),3)`;
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=0x101010:s=320x180:r=30:d=${seconds}`, "-f", "lavfi", "-i", `color=c=white:s=80x80:r=30:d=${seconds}`],
    ...["-filter_complex", `[0][1]overlay=x='20+200*${out}-200*${back}':y=50${extra}`, ...FILM, path],
  ]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = tempDir();
  await slideFilm(join(footage, "film.mp4"), 0, 8);
  await slideFilm(join(footage, "reference.mp4"), 1, 9);
  await slideFilm(join(footage, "negative.mp4"), 0, 8, ",negate");
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, [...["-hide_banner", "-loglevel", "error", "-y"], ...["-f", "lavfi", "-i", "testsrc=s=90x160:r=30:d=8"], ...FILM, join(footage, "vertical.mp4")]);
  late = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "reference.mp4") });
  negative = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "negative.mp4"), name: "against-negative", snapshots: 4 });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("analyze.diff", () => {
  it("matches the method's schema and is written to .frameshell/analysis/<name>/diff.json", () => {
    expect(methods["analyze.diff"].result.parse(late)).toEqual(late);
    expect(late.name).toBe("film-vs-reference");
    expect(late.dir).toBe(join(project, ".frameshell", "analysis", "film-vs-reference"));
    expect(JSON.parse(readFileSync(join(late.dir, "diff.json"), "utf8"))).toEqual(late);
    expect(late.film).toMatchObject({ file: join(footage, "film.mp4"), fps: 30, width: 320, height: 180, frames: 240, duration: 8 });
    expect(late.reference).toMatchObject({ frames: 270, duration: 9 });
  });

  it("lines the films up by their activity: the reference is a second later", () => {
    expect(late.alignment.source).toBe("activity");
    expect(late.alignment.lag).toBeGreaterThanOrEqual(0.9);
    expect(late.alignment.lag).toBeLessThanOrEqual(1.1);
    expect(late.alignment.correlation!).toBeGreaterThan(0.8);
    expect(late.alignment.maxLag).toBe(3);
    expect(late.warnings).toEqual([]);
  });

  it("compares the energy of the two over the stretch they share", () => {
    expect(late.energy.ratio!).toBeGreaterThan(0.8);
    expect(late.energy.ratio!).toBeLessThan(1.25);
    expect(late.energy.film.p95).toBeGreaterThan(1);
    // 1 s windows over the 8 s of the film that the reference has (it starts 1 s later and runs a second longer).
    expect(late.energy.step).toBe(1);
    expect(late.energy.windows).toHaveLength(8);
    expect(late.energy.windows[0]).toMatchObject({ at: 0 });
    // The slide starts at 1 s in both (at 2 s in the reference): both are moving in the window at 1 s, both still at 3.
    expect(late.energy.windows[1]!.film).toBeGreaterThan(1);
    expect(late.energy.windows[1]!.reference).toBeGreaterThan(1);
    expect(late.energy.windows[3]!.reference).toBeLessThan(0.5);
  });

  it("reads SSIM at matched times: near 1 for the same picture", () => {
    expect(late.diff.every).toBe(0.5);
    expect(late.diff.size).toEqual({ width: 320, height: 180 });
    expect(late.diff.samples.length).toBeGreaterThanOrEqual(15);
    expect(late.diff.samples.length).toBeLessThanOrEqual(16);
    expect(late.diff.samples[0]).toMatchObject({ at: 0 });
    expect(late.diff.samples[0]!.referenceAt).toBeCloseTo(late.alignment.lag, 3);
    expect(late.diff.mean).toBeGreaterThan(0.9);
    expect(late.diff.below).toBe(0);
    expect(late.diff.min).toBeLessThanOrEqual(late.diff.mean);
  });

  it("writes a side-by-side sheet, ours left and the reference right, with the lowest readings in it", () => {
    expect(late.sheets).toHaveLength(1);
    const [sheet] = late.sheets;
    expect(sheet!.kind).toBe("diff");
    expect(existsSync(sheet!.path)).toBe(true);
    expect(sheet!.path).toBe(join(late.dir, "diff.png"));
    // 8 pairs: 16 tiles, 4 columns (2 pairs a row).
    expect(sheet!.tiles).toHaveLength(16);
    expect(sheet!.columns).toBe(4);
    expect(sheet!.rows).toBe(4);
    expect(sheet!.tiles.filter((tile) => tile.label.startsWith("film ")).map((tile) => tile.column)).toEqual([0, 2, 0, 2, 0, 2, 0, 2]);
    expect(sheet!.tiles.filter((tile) => tile.label.startsWith("ref ")).map((tile) => tile.column)).toEqual([1, 3, 1, 3, 1, 3, 1, 3]);
    const times = sheet!.tiles.filter((tile) => tile.label.startsWith("film ")).map((tile) => tile.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const lowest = late.diff.samples.find((sample) => sample.ssim === late.diff.min)!;
    expect(times.some((at) => Math.abs(at - lowest.at) < 1e-6)).toBe(true);
    const png = readFileSync(sheet!.path);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([sheet!.width, sheet!.height]);
  });

  it("reads a negative of the same motion as moving alike and looking nothing alike", () => {
    expect(negative.name).toBe("against-negative");
    expect(negative.alignment).toMatchObject({ source: "activity", lag: 0 });
    expect(negative.energy.ratio!).toBeGreaterThan(0.8);
    expect(negative.energy.ratio!).toBeLessThan(1.25);
    expect(negative.diff.mean).toBeLessThan(0.5);
    expect(negative.diff.below).toBeGreaterThan(0.5);
    expect(negative.sheets[0]!.tiles).toHaveLength(8);
  });

  it("takes the lag the caller gives, and then reads the wrong moment when it is wrong", async () => {
    const forced = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "reference.mp4"), name: "forced", lag: 1, snapshots: 2 });
    expect(forced.alignment).toMatchObject({ lag: 1, source: "forced" });
    expect(labelOf(forced.labels, "alignment.lag")).toBe("DECISION");
    expect(forced.diff.mean).toBeGreaterThan(0.9);
    const wrong = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "reference.mp4"), name: "wrong", lag: 0, snapshots: 2 });
    expect(wrong.alignment).toMatchObject({ lag: 0, source: "forced" });
    expect(wrong.diff.mean).toBeLessThan(forced.diff.mean);
  });

  it("warns when the reference has another shape, and stretches it", async () => {
    const vertical = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "vertical.mp4"), name: "shape", snapshots: 2 });
    expect(vertical.warnings.some((warning) => warning.startsWith("shape:"))).toBe(true);
    expect(vertical.reference).toMatchObject({ width: 90, height: 160 });
    expect(vertical.diff.size).toEqual({ width: 320, height: 180 });
  });

  it("labels every value", () => {
    expect(late.labels).toEqual(ANALYZE_DIFF_LABELS);
    expect(labelOf(late.labels, "alignment.lag")).toBe("ESTIMATED");
    expect(labelOf(late.labels, "diff.samples[3].ssim")).toBe("MEASURED");
    expect(labelOf(late.labels, "energy.step")).toBe("DECISION");
    expect(labelOf(late.labels, "diff.size.width")).toBe("DECISION");
    const keys = Object.keys(late).filter((key) => key !== "labels");
    expect(keys.filter((key) => labelOf(late.labels, key) === null)).toEqual([]);
  });

  it("fails clearly for a missing file and for films that share nothing at that lag", async () => {
    await expect(conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "absent.mp4") })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    const error = await conn.request("analyze.diff", { cwd: project, file: join(footage, "film.mp4"), reference: join(footage, "reference.mp4"), lag: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(ErrorCode.InvalidOperation);
    expect((error as RpcError).message).toMatch(/share no stretch/);
  });
});
