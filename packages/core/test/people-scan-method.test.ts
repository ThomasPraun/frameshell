import { existsSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, type Face, type PeopleScanRequest, PEOPLE_DIR, scanPeopleFaces, startDaemon } from "../src/index.js";
import { makeMarkerClip, markerDetector } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `people.scan` through a real daemon and managed ffmpeg, with stand-in models (a white square is the face):
// nothing is downloaded.
const MEDIA_TIMEOUT = 180_000;
let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
const scanned: string[] = [];

/** The marker with the five landmarks YuNet would give, and a print that tells the two videos apart. */
const detect = async (frame: Parameters<typeof markerDetector>[0]): Promise<Face[]> =>
  (await markerDetector(frame)).map((face) => ({
    ...face,
    landmarks: [
      [face.x - face.width * 0.2, face.y - face.height * 0.1],
      [face.x + face.width * 0.2, face.y - face.height * 0.1],
      [face.x, face.y + face.height * 0.05],
      [face.x - face.width * 0.15, face.y + face.height * 0.25],
      [face.x + face.width * 0.15, face.y + face.height * 0.25],
    ],
  }));

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    peopleScanner: (request: PeopleScanRequest) => {
      scanned.push(request.path);
      return scanPeopleFaces({
        ...request,
        detect,
        embed: async () => {
          const vector = new Float32Array(128);
          vector[0] = 1;
          return vector;
        },
      });
    },
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const footage = tempDir();
  // Ana sits left for 4 s then right; Ben stays right and is 6 s long.
  await makeMarkerClip(ffmpeg, join(footage, "ana.mp4"), { x: "if(lt(t,4),40,240)" });
  await makeMarkerClip(ffmpeg, join(footage, "ben.mp4"), { x: "240", durationS: 6 });
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "-y", join(footage, "logo.png")]);
  await conn.request("asset.import", { cwd: project, files: ["ana.mp4", "ben.mp4", "logo.png"].map((name) => join(footage, name)) });
  writeFileSync(join(project, "assets", "notes.txt"), "not media");
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

const stored = async () => (await readdir(join(project, ...PEOPLE_DIR.split("/")))).sort();

describe("people.scan", () => {
  it(
    "scans every video by default, skips pictures and other files, caches per content and says so in job.list",
    async () => {
      const result = await conn.request("people.scan", { cwd: project });
      expect(methods["people.scan"].result.parse(result)).toEqual(result);
      expect(result.assets).toEqual([
        { asset: "assets/ana.mp4", cached: false, samples: 16, tracks: 2, embeddings: 8 },
        { asset: "assets/ben.mp4", cached: false, samples: 12, tracks: 1, embeddings: 6 },
      ]);
      expect(result.warnings).toEqual([]);
      expect(scanned.map((path) => path.split(/[\\/]/).at(-1))).toEqual(["ana.mp4", "ben.mp4"]);
      expect(await stored()).toHaveLength(4);

      const { jobs } = await conn.request("job.list", { cwd: project });
      expect(jobs.filter((job) => job.kind === "people")).toEqual([
        expect.objectContaining({ asset: "assets/ana.mp4,assets/ben.mp4,assets/logo.png,assets/notes.txt", state: "done", step: null, progress: 1 }),
      ]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "does not decode a video again while its content is cached, unless forced",
    async () => {
      const again = await conn.request("people.scan", { cwd: project, assets: ["assets/ben.mp4"] });
      expect(again.assets).toEqual([{ asset: "assets/ben.mp4", cached: true, samples: 12, tracks: 1, embeddings: 6 }]);
      expect(scanned).toHaveLength(2);

      const forced = await conn.request("people.scan", { cwd: project, assets: [join(project, "assets", "ben.mp4")], force: true });
      expect(forced.assets).toEqual([{ asset: "assets/ben.mp4", cached: false, samples: 12, tracks: 1, embeddings: 6 }]);
      expect(scanned).toHaveLength(3);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "warns about a picture that was asked for and refuses a path outside the project",
    async () => {
      const result = await conn.request("people.scan", { cwd: project, assets: ["assets/logo.png"] });
      expect(result).toMatchObject({ assets: [], warnings: ["assets/logo.png has no moving picture: skipped."] });
      await expect(conn.request("people.scan", { cwd: project, assets: [join(tempDir(), "x.mp4")] })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringContaining("not inside the project"),
      });
      await expect(conn.request("people.scan", { cwd: project, assets: ["assets/missing.mp4"] })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "is swept by gc when its content is gone or its models changed, and gc leaves other files of the folder alone",
    async () => {
      const dir = join(project, ...PEOPLE_DIR.split("/"));
      const stale = "0123456789abcdef0123-f1-abcdef";
      writeFileSync(join(dir, `${stale}.json`), "{}");
      writeFileSync(join(dir, `${stale}.f32`), "");
      writeFileSync(join(dir, "voices.json"), "{}");
      const dry = await conn.request("gc", { cwd: project, dryRun: true });
      expect(dry.removed.filter((entry) => entry.kind === "people").map((entry) => entry.path)).toEqual([
        `${PEOPLE_DIR}/${stale}.f32`,
        `${PEOPLE_DIR}/${stale}.json`,
      ]);
      await conn.request("gc", { cwd: project });
      expect(existsSync(join(dir, `${stale}.json`))).toBe(false);
      expect(existsSync(join(dir, "voices.json"))).toBe(true);
      expect((await stored()).filter((name) => name !== "voices.json")).toHaveLength(4);
    },
    MEDIA_TIMEOUT,
  );
});
