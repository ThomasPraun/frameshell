import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnalyzeResult, type DaemonConnection, ErrorCode, RpcError, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { clickTrack, wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// The `analyze` method on 12 s films of three still colours (black, white, gray: cuts at 4 s and 8 s), with real ffmpeg.
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;

/** Four seconds each of black, white and gray at 30 fps, then `audio` args: a click track at 120 BPM, a sine, or none. */
async function makeFilm(path: string, audio: "clicks" | "sine" | "none"): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const second = (color: string) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=4`];
  if (audio === "clicks") writeFileSync(join(footage, "clicks.wav"), wavOf(clickTrack({ bpm: 120, seconds: 12, offset: 0.2 }), 48_000));
  const sound = audio === "clicks" ? ["-i", join(footage, "clicks.wav")] : audio === "sine" ? ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=12"] : [];
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...second("black"),
    ...second("white"),
    ...second("0x808080"),
    ...sound,
    ...["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]"],
    ...(audio === "none" ? [] : ["-map", "3:a", "-c:a", "aac"]),
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", path],
  ]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = tempDir();
  await makeFilm(join(footage, "Reel One.mp4"), "clicks");
  await makeFilm(join(footage, "mute.mp4"), "none");
  await makeFilm(join(footage, "tone.mp4"), "sine");
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", join(footage, "voice.wav")]);
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

function pngSize(path: string): [number, number] {
  const png = readFileSync(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** `#rrggbb` is within `tolerance` levels of gray level `level` on every channel. */
function isGray(hex: string, level: number, tolerance = 8): boolean {
  return [1, 3, 5].every((at) => Math.abs(parseInt(hex.slice(at, at + 2), 16) - level) <= tolerance);
}

describe("analyze method", () => {
  let result: AnalyzeResult;

  it(
    "finds the shots, colours, loudness and tempo of a film, and writes them to .frameshell/analysis/<name>/",
    async () => {
      const projectBefore = readdirSync(project).sort();
      result = await conn.request("analyze", { cwd: project, file: join(footage, "Reel One.mp4") });
      expect(methods.analyze.result.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        file: join(footage, "Reel One.mp4"),
        name: "reel-one",
        dir: join(project, ".frameshell", "analysis", "reel-one"),
        fps: 30,
        width: 320,
        height: 180,
        frames: 360,
        duration: 12,
        threshold: 0.3,
      });
      expect(result.shots.map((shot) => [shot.index, shot.startFrame, shot.endFrame, shot.start, shot.end, shot.length])).toEqual([
        [1, 0, 120, 0, 4, 4],
        [2, 120, 240, 4, 8, 4],
        [3, 240, 360, 8, 12, 4],
      ]);
      expect(result.shots.map((shot) => shot.cutScore === null)).toEqual([true, false, false]);
      expect(result.stats).toEqual({ shotCount: 3, cutsPerMinute: 10, averageLength: 4, medianLength: 4, shortest: 4, longest: 4 });
      expect(readdirSync(project).sort()).toEqual(projectBefore);
    },
    MEDIA_TIMEOUT,
  );

  it("reads the dominant colour of each shot and of the film", () => {
    expect(isGray(result.shots[0]!.palette[0]!.hex, 0)).toBe(true);
    expect(isGray(result.shots[1]!.palette[0]!.hex, 255)).toBe(true);
    expect(isGray(result.shots[2]!.palette[0]!.hex, 128)).toBe(true);
    for (const shot of result.shots) expect(shot.palette[0]!.share).toBeGreaterThan(0.95);
    expect(result.palette).toHaveLength(3);
    for (const color of result.palette) expect(color.share).toBeCloseTo(1 / 3, 1);
  });

  it("reads the look and the rhythm of three still colours", () => {
    expect(result.shots.map((shot) => shot.look)).toEqual([
      { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
      // White is 235 of 255 in video levels converted back, a little short of 1.
      expect.objectContaining({ contrast: 0, saturation: 0, warmth: 0 }),
      expect.objectContaining({ contrast: 0, saturation: 0 }),
    ]);
    expect(result.shots[1]!.look.brightness).toBeGreaterThan(0.97);
    expect(result.shots[2]!.look.brightness).toBeGreaterThan(0.45);
    expect(result.shots[2]!.look.brightness).toBeLessThan(0.55);
    expect(result.look.brightness).toBeGreaterThan(0.45);
    expect(result.look.brightness).toBeLessThan(0.52);
    expect(result.look.grid).toHaveLength(48);
    // Every cell is black, white or gray: the grid of a film is the mean over its frames, here a third of each.
    for (const hex of result.look.grid) expect(isGray(hex, 128, 6)).toBe(true);
    expect(result.rhythm).toMatchObject({ shotLengthCv: 0, changeCount: 2, changesPerMinute: 10, longestStill: 4, largestGap: 4, bursts: [] });
    // Two frames of 359 move: the cuts.
    expect(result.rhythm.stillShare).toBeGreaterThan(0.99);
    expect(result.events.filter((event) => event.kind === "hold").map((event) => [event.startFrame, event.endFrame])).toEqual([[0, 120], [120, 240], [240, 360]]);
    expect(result.events.filter((event) => event.kind === "flash" || event.kind === "appear" || event.kind === "disappear")).toEqual([]);
  });

  it("measures the loudness by EBU R128 and the tempo of the clicks", () => {
    expect(result.loudness).not.toBeNull();
    expect(result.loudness!.integrated).toBeLessThan(-5);
    expect(result.loudness!.integrated).toBeGreaterThan(-60);
    expect(result.loudness!.truePeak).toBeLessThan(0);
    expect(result.tempo).toMatchObject({ meter: 4, low: false, detector: "onset-flux@1" });
    expect(result.tempo!.bpm).toBeGreaterThan(119);
    expect(result.tempo!.bpm).toBeLessThan(121);
    expect(result.tempo!.beatCount).toBeGreaterThanOrEqual(22);
    expect(result.warnings).toEqual([]);
  });

  it("writes the contact sheet at 2 frames a second with the cuts marked, a shots sheet and a JPEG per shot", () => {
    const contact = result.sheets.filter((sheet) => sheet.kind === "contact");
    const tiles = contact.flatMap((sheet) => sheet.tiles);
    expect(contact.map((sheet) => sheet.path)).toEqual([join(result.dir, "contact.png")]);
    // The first and last frame, the two cuts and a frame every half second but within 0.2 s of those.
    expect(tiles).toHaveLength(25);
    expect(tiles.filter((tile) => tile.tag === "cut").map((tile) => [tile.at, tile.frame])).toEqual([[4, 120], [8, 240]]);
    expect(tiles.filter((tile) => tile.tag === "grid").map((tile) => tile.at)).toEqual(expect.arrayContaining([0.5, 1, 3.5, 4.5, 11.5]));
    expect(tiles.map((tile) => tile.at)).toEqual([...tiles.map((tile) => tile.at)].sort((a, b) => a - b));
    const shots = result.sheets.filter((sheet) => sheet.kind === "shots");
    expect(shots).toHaveLength(1);
    expect(shots[0]!.tiles.map((tile) => [tile.label, tile.frame])).toEqual([["#1 0.00", 59], ["#2 4.00", 179], ["#3 8.00", 299]]);
    for (const sheet of result.sheets) {
      expect(existsSync(sheet.path)).toBe(true);
      expect(pngSize(sheet.path)).toEqual([sheet.width, sheet.height]);
    }
    expect(result.shots.map((shot) => shot.image)).toEqual([1, 2, 3].map((n) => join(result.dir, "frames", `shot-00${n}.jpg`)));
    for (const shot of result.shots) expect(existsSync(shot.image)).toBe(true);
  });

  it("writes analysis.json with the result and the beat lists", () => {
    const manifest = JSON.parse(readFileSync(join(result.dir, "analysis.json"), "utf8")) as Record<string, unknown> & {
      tempo: { beats: number[]; downbeats: number[]; beatCount: number };
      shots: { look: { grid: string[] } }[];
    };
    const { tempo, shots, ...rest } = manifest;
    const { tempo: shown, shots: shownShots, ...expected } = result;
    expect(rest).toEqual(expected);
    // The shots carry their colour grid in the file only.
    expect(shots.map(({ look: { grid: _grid, ...look } }) => look)).toEqual(shownShots.map((shot) => shot.look));
    expect(shots.map((shot) => shot.look.grid)).toHaveLength(3);
    for (const shot of shots) expect(shot.look.grid).toHaveLength(48);
    expect(tempo.beats).toHaveLength(shown!.beatCount);
    expect(tempo.downbeats).toHaveLength(shown!.downbeatCount);
    expect(tempo.beats[0]!).toBeCloseTo(0.2, 1);
    expect(tempo.beats[1]! - tempo.beats[0]!).toBeCloseTo(0.5, 1);
  });

  it("runs as an analyze job and reports progress", async () => {
    const stages: string[] = [];
    await conn.request("analyze", { cwd: project, file: join(footage, "Reel One.mp4"), name: "again" }, { onProgress: (update) => stages.push(update.message ?? "") });
    expect(stages[0]).toBe("Finding the shots of Reel One.mp4");
    expect(stages.at(-1)).toBe("Writing the sheets");
    const { jobs } = await conn.request("job.list", { cwd: project });
    expect(jobs.filter((job) => job.kind === "analyze")).toMatchObject([
      { state: "done", asset: join(footage, "Reel One.mp4").split("\\").join("/"), progress: 1 },
      { state: "done", asset: join(footage, "Reel One.mp4").split("\\").join("/") },
    ]);
  });

  it(
    "replaces the folder of an analysis with the same name and keeps others",
    async () => {
      writeFileSync(join(result.dir, "stale.txt"), "old");
      await conn.request("analyze", { cwd: project, file: join(footage, "mute.mp4"), name: "reel-one" });
      expect(existsSync(join(result.dir, "stale.txt"))).toBe(false);
      expect(existsSync(join(project, ".frameshell", "analysis", "again", "analysis.json"))).toBe(true);
      // The scratch folder is gone.
      expect(readdirSync(join(project, ".frameshell", "cache", "analyze"))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "says a film with no sound has no loudness or tempo",
    async () => {
      const mute = await conn.request("analyze", { cwd: project, file: join(footage, "mute.mp4"), name: "mute" });
      expect(mute).toMatchObject({ loudness: null, tempo: null, stats: { shotCount: 3 } });
      expect(mute.warnings).toEqual(["audio: the video has no sound, so there is no loudness, tempo or hits."]);
      const manifest = JSON.parse(readFileSync(join(mute.dir, "analysis.json"), "utf8")) as { tempo: unknown };
      expect(manifest.tempo).toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "measures the loudness of a steady tone but finds no beat in it",
    async () => {
      const tone = await conn.request("analyze", { cwd: project, file: join(footage, "tone.mp4"), name: "tone" });
      expect(tone.loudness!.integrated).not.toBeNull();
      expect(tone.tempo).toBeNull();
      expect(tone.warnings).toHaveLength(1);
      expect(tone.warnings[0]).toMatch(/^tempo: /);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "opens a shot only at or above the threshold",
    async () => {
      const scores = result.shots.slice(1).map((shot) => shot.cutScore!);
      const between = (Math.min(...scores) + Math.max(...scores)) / 2;
      if (Math.min(...scores) === Math.max(...scores)) return;
      const coarse = await conn.request("analyze", { cwd: project, file: join(footage, "mute.mp4"), name: "coarse", threshold: between });
      expect(coarse.shots).toHaveLength(2);
      expect(coarse.threshold).toBe(between);
    },
    MEDIA_TIMEOUT,
  );

  it("fails with AssetNotFound for a missing file and InvalidOperation for sound alone", async () => {
    const missing = await conn.request("analyze", { cwd: project, file: join(footage, "nope.mp4") }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(RpcError);
    expect((missing as RpcError).code).toBe(ErrorCode.AssetNotFound);
    const sound = await conn.request("analyze", { cwd: project, file: join(footage, "voice.wav") }).catch((error: unknown) => error);
    expect((sound as RpcError).code).toBe(ErrorCode.InvalidOperation);
    expect((sound as RpcError).message).toContain("analyze:");
  });

  it("refuses a name that is not a folder name", async () => {
    const bad = await conn.request("analyze", { cwd: project, file: join(footage, "mute.mp4"), name: "../out" }).catch((error: unknown) => error);
    expect((bad as RpcError).code).toBe(ErrorCode.InvalidParams);
  });
});
