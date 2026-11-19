import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, PEOPLE_DIR, type PeopleScanRequest, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `analyze` finds the faces itself for the mouth sync, with real ffmpeg and a stand-in scanner that sees one face
// the whole film (nothing is downloaded). Films outside the project, 8 s at 30 fps, 320x180: a tone in bursts and a "mouth"
// that flickers in the same bursts `shift` seconds later; each shift is a different file, so a scan of one is no scan of another.
const MEDIA_TIMEOUT = 240_000;
const FILM = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "300"];
const VOICE: [number, number][] = [[1, 1.5], [2.4, 3.1], [4.2, 4.6], [5.5, 6.3]];

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
/** What the stand-in scanner does next: a face the whole film, or a failure with this message. */
let scannerMode: "face" | { fails: string } = "face";
const scanned: string[] = [];

const inAny = (spans: [number, number][], shift = 0) => spans.map(([from, to]) => `between(t,${from + shift},${to + shift})`).join("+");

async function makeTalk(name: string, shift: number): Promise<string> {
  const { ffmpeg } = await mediaTools();
  const file = join(footage, name);
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=0x404040:s=320x180:r=30:d=8,drawbox=x=144:y=99:w=32:h=20:color=white:t=fill:enable='(${inAny(VOICE, shift)})*lt(mod(n,2),1)'`],
    ...["-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*440*t)*(${inAny(VOICE)})':s=48000:d=8`],
    ...["-map", "0:v", "-map", "1:a", "-c:a", "aac", ...FILM, file],
  ]);
  return file;
}

const analyze = (file: string, extra: { faces?: boolean; name?: string } = {}) => conn.request("analyze", { cwd: project, file, ...extra });
const scansInProject = () => readdirSync(join(project, ...PEOPLE_DIR.split("/"))).filter((name) => name.endsWith(".json"));

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    peopleScanner: async (request: PeopleScanRequest) => {
      scanned.push(request.path);
      if (scannerMode !== "face") throw new Error(scannerMode.fails);
      const boxes = Array.from({ length: 17 }, (_, i) => ({ time: i / 2, x: 0.5, y: 0.45, width: 0.4, height: 0.5, score: 0.9 }));
      return { width: request.width, height: request.height, samples: 17, tracks: [{ id: "t1", start: 0, end: 8, boxes, embeddings: [] }] };
    },
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = tempDir();
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("analyze faces", () => {
  it(
    "scans the faces of a reference outside the project, measures the lag from them and caches the scan by content",
    async () => {
      const file = await makeTalk("talk.mp4", 0.2);
      const stages: string[] = [];
      const result = await conn.request("analyze", { cwd: project, file }, { onProgress: (update) => stages.push(update.message ?? "") });
      expect(methods.analyze.result.parse(result)).toEqual(result);
      expect(scanned).toEqual([file]);
      expect(stages).toContain("Finding faces in talk.mp4");
      expect(result.sync.reason).toBeNull();
      expect(result.sync.track).toBe("t1");
      expect(result.sync.offset!).toBeGreaterThanOrEqual(0.13);
      expect(result.sync.offset!).toBeLessThanOrEqual(0.27);
      expect(result.sync.confidence!).toBeGreaterThan(0.5);
      expect(result.warnings.some((warning) => warning.startsWith("sync:"))).toBe(false);
      expect(scansInProject()).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "reads the cached scan the second time and scans nothing",
    async () => {
      const again = await analyze(join(footage, "talk.mp4"), { name: "talk-again" });
      expect(scanned).toHaveLength(1);
      expect(again.sync.track).toBe("t1");
      expect(again.sync.offset!).toBeGreaterThanOrEqual(0.13);
      expect(scansInProject()).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "skips the scan with faces: false, says so, and still uses a scan that is cached",
    async () => {
      const fresh = await makeTalk("quiet-faces.mp4", 0.1);
      const before = scanned.length;
      const skipped = await analyze(fresh, { faces: false, name: "no-faces" });
      expect(scanned).toHaveLength(before);
      expect(skipped.sync).toMatchObject({ offset: null, confidence: null, track: null });
      expect(skipped.sync.reason).toMatch(/faces: false/);
      expect(skipped.warnings.some((warning) => warning.startsWith("sync:"))).toBe(false);
      const cached = await analyze(join(footage, "talk.mp4"), { faces: false, name: "cached" });
      expect(cached.sync.track).toBe("t1");
      expect(scanned).toHaveLength(before);
      // No face scan ran for the skipped one: the project still holds one.
      expect(scansInProject()).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "turns a scan that fails into a skipped sync with its reason and a warning, never a failed run",
    async () => {
      const file = await makeTalk("fails.mp4", 0.3);
      scannerMode = { fails: "the face model could not be downloaded" };
      try {
        const result = await analyze(file, { name: "fails" });
        expect(result.sync).toMatchObject({ offset: null, track: null });
        expect(result.sync.reason).toMatch(/the faces could not be scanned: the face model could not be downloaded/);
        expect(result.warnings).toContainEqual(expect.stringMatching(/^sync: the faces could not be scanned/));
        // The rest of the run is whole.
        expect(result.shots.length).toBeGreaterThan(0);
        expect(result.loudness).not.toBeNull();
        expect(scansInProject()).toHaveLength(1);
      } finally {
        scannerMode = "face";
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps the reason of a film with no sound and does not scan it",
    async () => {
      const { ffmpeg } = await mediaTools();
      const mute = join(footage, "mute.mp4");
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=2", ...FILM, mute]);
      const before = scanned.length;
      const silent = await analyze(mute, { name: "mute" });
      expect(silent.sync.reason).toMatch(/no sound/);
      expect(scanned).toHaveLength(before);
    },
    MEDIA_TIMEOUT,
  );
});
