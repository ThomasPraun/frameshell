import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { noFaceScanner } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `review` and `analyze` on one scale (#457, #471), with real ffmpeg: a 5.8 s film of still colours, black held 3.5 s,
// then four 0.2 s flashes (white, red, blue, green: a burst of cuts) and 1.5 s of gray.
const MEDIA_TIMEOUT = 300_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;

async function makeFilm(path: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const shots: [string, number][] = [
    ["black", 3.5],
    ["white", 0.2],
    ["red", 0.2],
    ["blue", 0.2],
    ["green", 0.2],
    ["0x808080", 1.5],
  ];
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...shots.flatMap(([color, seconds]) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=${seconds}`]),
    ...["-filter_complex", `concat=n=${shots.length}:v=1:a=0`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
  ]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity, peopleScanner: noFaceScanner });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = join(tempDir(), "flashes.mp4");
  await makeFilm(footage);
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("review rhythm", () => {
  it(
    "review of a file and analyze of it agree on shot-length CV, still share and bursts",
    async () => {
      const reviewed = (await conn.request("review", { cwd: project, file: footage, sheets: ["metrics"] })).metrics!;
      const analyzed = await conn.request("analyze", { cwd: project, file: footage });
      expect(reviewed.picture).toMatchObject({ samples: 174, sampled: false });
      expect(reviewed.rhythm.label).toBe("MEASURED");
      expect(analyzed.rhythm.bursts.length).toBe(1);
      expect(analyzed.rhythm.shotLengthCv).toBeGreaterThan(0.25);
      expect(reviewed.rhythm.shotLengthCv).toBe(analyzed.rhythm.shotLengthCv);
      expect(reviewed.rhythm.stillShare).toBe(analyzed.rhythm.stillShare);
      expect(reviewed.rhythm.bursts).toEqual(analyzed.rhythm.bursts.map((burst) => ({ from: burst.start, to: burst.end, count: burst.count })));
      // The black hold: 105 frames, the whole 3.5 s.
      expect(reviewed.picture.longestStatic).toEqual({ from: 0, to: 3.5, seconds: 3.5 });
      expect(reviewed.craft.map((warning) => warning.check)).toContain("static");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a timeline over 90 frames is sampled, its rhythm ESTIMATED, and its still hold still warns",
    async () => {
      const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
      const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
      await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0 });
      const metrics = (await conn.request("review", { cwd: project, timeline: "main", sheets: ["metrics"] })).metrics!;
      expect(metrics.picture).toMatchObject({ samples: 87, sampled: true });
      expect(metrics.rhythm.label).toBe("ESTIMATED");
      const hold = metrics.craft.find((warning) => warning.check === "static");
      expect(hold).toMatchObject({ from: 0 });
      expect(hold!.to).toBeGreaterThan(3.4);
    },
    MEDIA_TIMEOUT,
  );
});
