import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { type Daemon, SHEET_GAP, columnsFor, lookFlags, startDaemon, withGrade } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, runBuffer, testBinaryManager } from "./media-tools.js";

// `grade.compare` (#384, ADR 0031): the pure parts (flags that keep a look, layout, the grade swap), then the method
// through a real daemon and the managed ffmpeg on a flat grey still, reading back the centre pixel of every tile.
const MEDIA_TIMEOUT = 240_000;

describe("lookFlags", () => {
  it("gives a look's fields, and with no grade on the clip nothing more", () => {
    expect(lookFlags({ temperature: 0.25, saturation: 1.1 }, null)).toBe("--grade-temperature 0.25 --grade-saturation 1.1");
    expect(lookFlags({ exposure: -0.5, lut: "luts/teal.cube", lutMix: 0.6 }, null)).toBe("--grade-exposure=-0.5 --grade-lut luts/teal.cube --grade-lut-mix 0.6");
  });

  it("sets back to neutral what the clip's grade sets and the look leaves out, and skips what is already so", () => {
    const current = { exposure: 1, temperature: 0.25, lut: "luts/a.cube", lutMix: 0.5 };
    expect(lookFlags({ temperature: 0.25, contrast: 1.2 }, current)).toBe("--grade-exposure 0 --grade-contrast 1.2 --grade-lut none --grade-lut-mix 1");
    expect(lookFlags(current, current)).toBe("");
  });

  it("quotes a LUT path the shell would split", () => {
    expect(lookFlags({ lut: "luts/my look.cube" }, null)).toBe('--grade-lut "luts/my look.cube"');
  });
});

describe("compare layout and grade swap", () => {
  it("puts up to 4 tiles in one row, more about square", () => {
    expect([2, 3, 4, 5, 9, 10, 18].map(columnsFor)).toEqual([2, 3, 4, 3, 3, 4, 5]);
  });

  it("swaps only the named clip's grade, leaving the timeline it was given as it was", () => {
    const timeline = {
      version: 1,
      id: "main",
      revision: 3,
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "a", type: "media", asset: "assets/a.png", start: 0, in: 0, out: 2, grade: { exposure: 1 } }, { id: "b", type: "media", asset: "assets/b.png", start: 2, in: 0, out: 2 }] },
      ],
    } as unknown as Timeline;
    const before = structuredClone(timeline);
    const clips = (t: Timeline) => (t.tracks[0] as { clips: { id: string; grade?: unknown }[] }).clips;
    expect(clips(withGrade(timeline, "a", { contrast: 1.2 }))[0]!.grade).toEqual({ contrast: 1.2 });
    expect("grade" in clips(withGrade(timeline, "a", null))[0]!).toBe(false);
    expect(clips(withGrade(timeline, "a", null))[1]).toBe(clips(timeline)[1]);
    expect(timeline).toEqual(before);
  });
});

describe("grade.compare", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;
  let ffmpeg: string;
  let still: string;
  let audioClip: string;
  const W = 320;
  const H = 180;

  const timelineFile = () => readFile(join(project, "timelines", "main.json"), "utf8");

  /** Centre pixel of tile `index` of a sheet laid out `columns` wide with tiles `tile` px. */
  async function tileColour(path: string, index: number, columns: number, tile: { width: number; height: number }): Promise<number[]> {
    const x = SHEET_GAP + (index % columns) * (tile.width + SHEET_GAP) + tile.width / 2;
    const y = SHEET_GAP + Math.floor(index / columns) * (tile.height + SHEET_GAP) + tile.height * 0.75;
    const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", `crop=1:1:${x}:${Math.round(y)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    return [...raw];
  }

  beforeAll(async () => {
    ({ ffmpeg } = await mediaTools());
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    const config = JSON.parse(await readFile(join(project, "frameshell.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(project, "frameshell.json"), JSON.stringify({ ...config, resolution: { width: W, height: H } }));
    const footage = tempDir();
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x787878:s=${W}x${H},format=rgb24`, "-frames:v", "1", join(footage, "grey.png")]);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(footage, "tone.wav")]);
    await conn.request("asset.import", { cwd: project, files: [join(footage, "grey.png"), join(footage, "tone.wav")] });
    mkdirSync(join(project, "luts"), { recursive: true });
    // Every colour to pure red: a look nobody would keep, and that no grade of grey can be mistaken for.
    writeFileSync(join(project, "luts", "red.cube"), `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, () => "1 0 0").join("\n")}\n`);
    const track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    const audioTrack = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
    still = (await conn.request("clip.add", { cwd: project, track, asset: "assets/grey.png", start: 0, duration: 2 })).changes.added[0]!;
    audioClip = (await conn.request("clip.add", { cwd: project, track: audioTrack, asset: "assets/tone.wav", start: 0 })).changes.added[0]!;
  }, MEDIA_TIMEOUT);

  afterAll(async () => {
    conn.close();
    await daemon.close();
  });

  it(
    "renders the neutral baseline and each look on one frame, labelled, and changes nothing",
    async () => {
      const before = await timelineFile();
      const result = await conn.request("grade.compare", {
        cwd: project,
        timeline: "main",
        clip: still,
        tileWidth: 160,
        looks: [{ name: "bright", exposure: 1 }, { name: "warm", temperature: 1 }, { lut: "luts/red.cube" }, {}],
      });
      expect(methods["grade.compare"].result.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ clip: still, asset: "assets/grey.png", frame: 30, at: 1, columns: 3, rows: 2, view: "current" });
      expect(result.path).toBe(join(project, ".frameshell", "grade", `compare-${still}-30.png`));
      expect(result.tiles.map((tile) => tile.label)).toEqual(["1 neutral", "2 bright", "3 warm", "4 look 3", "5 look 4"]);
      expect(result.tiles.map((tile) => tile.flags)).toEqual(["--clear-grade", "--grade-exposure 1", "--grade-temperature 1", "--grade-lut luts/red.cube", ""]);
      expect(result.warnings).toEqual(['Look "look 4" changes nothing: its tile is the neutral picture.']);
      expect({ width: result.width, height: result.height }).toEqual({ width: 3 * (160 + SHEET_GAP) + SHEET_GAP, height: 2 * (90 + SHEET_GAP) + SHEET_GAP });
      const tile = { width: 160, height: 90 };
      const [neutral, bright, warm, red, none] = await Promise.all([0, 1, 2, 3, 4].map((i) => tileColour(result.path, i, 3, tile)));
      // Grey 120 drawn as is, give or take the scaling.
      for (const channel of neutral!) expect(Math.abs(channel - 120)).toBeLessThanOrEqual(2);
      expect(Math.min(...bright!)).toBeGreaterThan(140);
      expect(warm![0]! - warm![2]!).toBeGreaterThan(10);
      expect(red![0]).toBeGreaterThan(240);
      expect(red![1]! + red![2]!).toBeLessThan(10);
      expect(none).toEqual(neutral);
      // Read only: the timeline file is byte for byte as it was, and no scratch is left behind.
      expect(await timelineFile()).toBe(before);
      expect(readdirSync(join(project, ".frameshell", "cache")).filter((name) => name.startsWith("grade-compare")).flatMap((name) => readdirSync(join(project, ".frameshell", "cache", name)))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "adds the clip's own grade after the baseline, and gives each look the flags from that grade",
    async () => {
      await conn.request("clip.set", { cwd: project, clip: still, grade: { exposure: -1 } });
      const out = join(tempDir(), "sheets", "compare.png");
      const result = await conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, at: 0.5, out, tileWidth: 160, looks: [{ name: "warm", temperature: 0.5 }] });
      expect(result).toMatchObject({ path: out, frame: 15, columns: 3, rows: 1 });
      expect(existsSync(out)).toBe(true);
      expect(result.tiles.map(({ label, kind, grade, flags }) => ({ label, kind, grade, flags }))).toEqual([
        { label: "1 neutral", kind: "neutral", grade: null, flags: "--clear-grade" },
        { label: "2 current", kind: "current", grade: { exposure: -1 }, flags: "" },
        { label: "3 warm", kind: "look", grade: { temperature: 0.5 }, flags: "--grade-exposure 0 --grade-temperature 0.5" },
      ]);
      const [neutral, current] = await Promise.all([0, 1].map((i) => tileColour(out, i, 3, { width: 160, height: 90 })));
      expect(current![1]).toBeLessThan(neutral![1]! - 20);
      await conn.request("clip.set", { cwd: project, clip: still, grade: null });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a clip it cannot grade, a frame outside the clip, a LUT it cannot read, and too many looks",
    async () => {
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: "c_none", looks: [{}] })).rejects.toMatchObject({ code: ErrorCode.ClipNotFound });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: audioClip, looks: [{}] })).rejects.toMatchObject({ code: ErrorCode.ClipNotFound });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, at: 3, looks: [{}] })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { reason: "outside-clip", valid: { from: 0, to: 2 } },
      });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, looks: [{ name: "gone", lut: "luts/gone.cube" }] })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/look "gone" uses LUT luts\/gone\.cube.*no such file/),
      });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, looks: [{ lut: "../outside.cube" }] })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, looks: Array.from({ length: 17 }, () => ({})) })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(conn.request("grade.compare", { cwd: project, timeline: "main", clip: still, out: "sheet.jpg", looks: [{}] })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    },
    MEDIA_TIMEOUT,
  );
});
