import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYZE_RESULT_LABELS, type AnalyzeResult, type DaemonConnection, connectToDaemon, labelOf, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `analyze` cuts (#471 slice 4) with real ffmpeg on a 9 s film at 30 fps, 320x180, six 1.5 s segments:
//   0.0 s  scene A, a bright box on the left
//   1.5 s  scene A, the box moved right           -> a jump cut (the scene score misses it)
//   3.0 s  the same, scaled 1.4x about the centre -> a punch-in (a big one: the scene score sees it too)
//   4.5 s  scene B, another pattern               -> a cut
//   6.0 s  scene B, the box moved                 -> a jump cut
//   7.5 s  scene B, a small bright element shows  -> a change, not a cut
const MEDIA_TIMEOUT = 240_000;

let daemon: Daemon;
let conn: DaemonConnection;
let result: AnalyzeResult;

const SCENE_A = "nullsrc=s=320x180:r=30:d=1.5,format=yuv420p,geq=lum='100+60*sin(X/9)*cos(Y/7)+40*(X/W)*(Y/H)':cb=128:cr=128";
const SCENE_B = "nullsrc=s=320x180:r=30:d=1.5,format=yuv420p,geq=lum='128+70*sin((X+2*Y)/11)':cb=128:cr=128";
const box = (x: number, y: number, size = 50) => `drawbox=x=${x}:y=${y}:w=${size}:h=${size}:color=white:t=fill`;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  const project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  const { ffmpeg } = await mediaTools();
  const segments = [
    `${SCENE_A},${box(40, 60)}`,
    `${SCENE_A},${box(200, 70)}`,
    `${SCENE_A},${box(200, 70)},scale=448:252,crop=320:180`,
    `${SCENE_B},${box(40, 60)}`,
    `${SCENE_B},${box(200, 70)}`,
    `${SCENE_B},${box(200, 70)},${box(20, 10, 24)}`,
  ];
  const film = join(footage, "Cuts.mp4");
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...segments.flatMap((segment) => ["-f", "lavfi", "-i", segment]),
    ...["-filter_complex", `${segments.map((_, i) => `[${i}:v]`).join("")}concat=n=${segments.length}:v=1:a=0[v]`],
    ...["-map", "[v]", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "300", film],
  ]);
  result = await conn.request("analyze", { cwd: project, file: film });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("analyze cuts", () => {
  it("matches the method's schema", () => {
    expect(methods.analyze.result.parse(result)).toEqual(result);
  });

  it("tells the jump cuts, the punch-in, the cut and the change apart", () => {
    const at = (seconds: number) => result.cuts.list.find((cut) => Math.abs(cut.time - seconds) < 0.1);
    expect(at(1.5)).toMatchObject({ kind: "jump", scale: null, opensShot: false });
    expect(at(3)).toMatchObject({ kind: "punch-in" });
    expect(at(3)!.scale).toBeGreaterThan(1.3);
    expect(at(3)!.scale).toBeLessThan(1.5);
    expect(at(4.5)).toMatchObject({ kind: "cut", opensShot: true });
    expect(at(6)).toMatchObject({ kind: "jump", opensShot: false });
    expect(at(7.5)).toMatchObject({ kind: "change", opensShot: false });
  });

  it("counts them and keeps the list in time order", () => {
    expect(result.cuts.counts).toMatchObject({ cut: 1, jump: 2, "punch-in": 1, "punch-out": 0 });
    expect(result.cuts.counts.change).toBeGreaterThanOrEqual(1);
    expect(result.cuts.list.map((cut) => cut.kind).filter((kind) => kind !== "change")).toEqual(["jump", "punch-in", "cut", "jump"]);
    const frames = result.cuts.list.map((cut) => cut.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    // Three jump cuts and punches in 9 s.
    expect(result.cuts.jumpsPerMinute).toBeCloseTo(20, 1);
  });

  it("leaves the shot table to the scene score, which misses both jump cuts", () => {
    expect(result.shots.map((shot) => Math.round(shot.start * 2) / 2)).toEqual([0, 3, 4.5]);
  });

  it("labels what it estimates and what it measured", () => {
    expect(result.labels).toEqual(ANALYZE_RESULT_LABELS);
    expect(labelOf(result.labels, "cuts.counts.jump")).toBe("ESTIMATED");
    expect(labelOf(result.labels, "cuts.list[2].kind")).toBe("ESTIMATED");
    expect(labelOf(result.labels, "cuts.list[2].scale")).toBe("ESTIMATED");
    expect(labelOf(result.labels, "cuts.list[2].frame")).toBe("MEASURED");
  });
});
