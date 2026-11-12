import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnalyzeResult, type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { clickTrack, wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `analyze` events, look and rhythm on a 10 s film at 30 fps: a gray field, a white box in the top right from 2 s to 5 s,
// a white flash from 7.0 s to 7.1 s, and a click every half second from 0 s (so one lands on the box coming and one on the flash).
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let result: AnalyzeResult;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  const { ffmpeg } = await mediaTools();
  writeFileSync(join(footage, "clicks.wav"), wavOf(clickTrack({ bpm: 120, seconds: 10, offset: 0 }), 48_000));
  const picture = [
    "color=c=0x404040:s=320x180:r=30:d=10",
    "drawbox=x=200:y=20:w=100:h=60:color=white:t=fill:enable='between(t,2,5)'",
    "drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='between(t,7,7.1)'",
  ].join(",");
  const film = join(footage, "Motion.mp4");
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", picture, "-i", join(footage, "clicks.wav")],
    ...["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "300", "-shortest", film],
  ]);
  result = await conn.request("analyze", { cwd: project, file: film });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("analyze events, look and rhythm", () => {
  it("matches the method's schema", () => {
    expect(methods.analyze.result.parse(result)).toEqual(result);
  });

  it("finds the element appearing and disappearing, with where it is", () => {
    const element = result.events.filter((event) => event.kind === "appear" || event.kind === "disappear");
    expect(element.map((event) => [event.kind, event.startFrame])).toEqual([["appear", 60], ["disappear", 151]]);
    for (const event of element) {
      // Columns 5 to 7 and rows 0 to 2 of the 8 x 6 grid.
      expect(event.region).toEqual({ x: 0.625, y: 0, width: 0.375, height: 0.5 });
      expect(event.area).toBeCloseTo(0.188, 2);
    }
  });

  it("finds the flash, brighter, a few frames long", () => {
    const flash = result.events.filter((event) => event.kind === "flash");
    expect(flash).toHaveLength(1);
    expect(flash[0]).toMatchObject({ direction: "up", startFrame: 210 });
    expect(flash[0]!.endFrame - flash[0]!.startFrame).toBeGreaterThanOrEqual(3);
    expect(flash[0]!.endFrame - flash[0]!.startFrame).toBeLessThanOrEqual(4);
    expect(flash[0]!.amount).toBeGreaterThan(0.6);
  });

  it("finds the holds between", () => {
    const held = result.events.filter((event) => event.kind === "hold").map((event) => [event.startFrame, event.endFrame]);
    // Before the box (0 to 2 s), while it shows (2 to 5 s) and after the flash.
    expect(held).toContainEqual([0, 60]);
    expect(held.some(([from, to]) => Math.abs(from! - 60) <= 1 && Math.abs(to! - 150) <= 1)).toBe(true);
    expect(held.some(([from, to]) => from! >= 214 && to === 300)).toBe(true);
  });

  it("finds the hits of the clicks and says which ones sit on the picture changing", () => {
    const hits = result.events.filter((event) => event.kind === "hit");
    expect(hits.length).toBeGreaterThanOrEqual(17);
    expect(hits.length).toBeLessThanOrEqual(21);
    const at = (seconds: number) => hits.find((hit) => Math.abs(hit.start - seconds) < 0.1);
    // The click at 2.0 s comes with the box, the one at 7.0 s with the flash; the one at 4.5 s has nothing near.
    expect(Math.abs(at(2)!.offset!)).toBeLessThanOrEqual(0.07);
    expect(Math.abs(at(7)!.offset!)).toBeLessThanOrEqual(0.07);
    expect(at(4.5)!.offset).toBeNull();
    expect(at(4.5)!.level).toBeLessThan(0);
    expect(at(4.5)!.amount).toBeGreaterThan(12);
  });

  it("lists the events in time order", () => {
    const starts = result.events.map((event) => event.startFrame);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("measures the rhythm", () => {
    // The box coming, going, and the flash's two edges: the flash opens and closes a shot at the default threshold.
    expect(result.rhythm.changeCount).toBeGreaterThanOrEqual(4);
    expect(result.rhythm.stillShare).toBeGreaterThan(0.9);
    expect(result.rhythm.longestStill).toBeGreaterThanOrEqual(2.9);
    expect(result.rhythm.largestGap).toBeGreaterThanOrEqual(2.9);
    expect(result.rhythm.bursts).toEqual([]);
    expect(result.rhythm.shotLengthCv).toBeGreaterThan(0);
  });

  it("measures the look: a gray, flat, neutral picture", () => {
    expect(result.look.brightness).toBeGreaterThan(0.25);
    expect(result.look.brightness).toBeLessThan(0.4);
    expect(result.look.saturation).toBeLessThan(0.02);
    expect(Math.abs(result.look.warmth)).toBeLessThan(0.02);
    expect(result.look.grid).toHaveLength(48);
    // A cell the box covers (column 6, row 1) is lighter than one in the bottom left: the box shows for 3 of the 10 s.
    const brightness = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    expect(brightness(result.look.grid[14]!)).toBeGreaterThan(brightness(result.look.grid[40]!) + 40);
  });
});
