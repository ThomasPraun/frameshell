import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { coverPixels, countFrames, decode } from "./cover-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// The `cover` method and the `cover` option of `render` on a 1 s project, with real ffmpeg.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = join(tempDir(), "take.mp4");
  await makeClip(footage, { durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1 });
  const transcript = {
    schemaVersion: 1,
    asset: "assets/take.mp4",
    assetHash: `sha256:${"c".repeat(64)}`,
    provider: "test",
    model: "test",
    words: [{ id: "w_000001", text: "Hola,", start: 0.3, end: 0.7 }],
    edits: {},
  };
  await conn.request("file.write", { path: join(project, "transcripts", "take.words.json"), content: JSON.stringify(transcript) });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function finished(id: string): Promise<JobInfo> {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
    const job = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === id);
    if (job && job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

describe("cover method", () => {
  it(
    "draws the word over the frame where it is first spoken, and says it reads at thumbnail size",
    async () => {
      const out = join(tempDir(), "cover.png");
      const result = await conn.request("cover", { cwd: project, text: "hola", out });
      expect(result).toMatchObject({
        path: out,
        format: "png",
        timeline: "main",
        frame: 9,
        at: 0.3,
        source: "word",
        text: "HOLA",
        width: 1920,
        height: 1080,
        warnings: [],
        readability: { thumbnailWidth: 180, readable: true },
      });
      expect(result.readability!.capHeight).toBeGreaterThanOrEqual(result.readability!.minCapHeight);
      const png = readFileSync(out);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);

      const plain = join(tempDir(), "plain.png");
      await conn.request("frame", { cwd: project, at: 0.3, out: plain });
      const bare = coverPixels(await decode(plain, "null"));
      // The test pattern has a few such pixels itself; the word adds a large block of them.
      expect(coverPixels(await decode(out, "null"))).toBeGreaterThan(bare + 20_000);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "defaults the file to exports/<timeline>-cover.png and takes the frame from `at`, a size from a preset",
    async () => {
      const result = await conn.request("cover", { cwd: project, at: 0.5, text: "Sí", preset: "youtube-1440p" });
      expect(result).toMatchObject({ path: join(project, "exports", "main-cover.png"), source: "at", at: 0.5, width: 2560, height: 1440, text: "SÍ" });
      expect(coverPixels(await decode(result.path, "null"))).toBeGreaterThan(20_000);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "without a word is the bare first picture",
    async () => {
      const result = await conn.request("cover", { cwd: project, out: join(tempDir(), "bare.jpg") });
      expect(result).toMatchObject({ format: "jpg", source: "default", at: 0, text: null, readability: null, warnings: [] });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "falls back to the first picture with a warning when nobody says the word, and warns about a word too long to read",
    async () => {
      const missing = await conn.request("cover", { cwd: project, text: "adiós", out: join(tempDir(), "missing.png") });
      expect(missing).toMatchObject({ source: "default", at: 0 });
      expect(missing.warnings).toEqual([expect.stringContaining('"ADIÓS" is not spoken in any transcript')]);

      const long = await conn.request("cover", { cwd: project, at: 0.3, text: "la verdad sobre tiempo", out: join(tempDir(), "long.png") });
      expect(long.readability).toMatchObject({ readable: false });
      expect(long.warnings).toEqual([expect.stringContaining("Use a shorter word")]);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses text with nothing to draw, text that is too long and a frame outside the timeline", async () => {
    const out = join(tempDir(), "x.png");
    await expect(conn.request("cover", { cwd: project, text: "{}", out })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "cover", field: "text" },
    });
    await expect(conn.request("cover", { cwd: project, text: "x".repeat(25), out })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(conn.request("cover", { cwd: project, at: 5, out })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "frame", valid: { min: 0, max: 0.967 } },
    });
  });
});

describe("render with a cover frame", () => {
  it(
    "makes frame 0 the cover and leaves the other frames and the length alone",
    async () => {
      const result = await conn.request("render", { cwd: project, cover: { text: "hola" } });
      expect(result.warnings).toEqual([]);
      expect(result.duration).toBe(1);
      expect((await finished(result.job.id)).state).toBe("done");

      const first = coverPixels(await decode(result.output, "select=eq(n\\,0)"));
      const later = coverPixels(await decode(result.output, "select=eq(n\\,15)"));
      expect(first).toBeGreaterThan(later + 20_000);
      expect(await countFrames(result.output)).toBe(30);
    },
    MEDIA_TIMEOUT,
  );

  it("passes the cover's warnings on", async () => {
    const result = await conn.request("render", { cwd: project, cover: { text: "adiós" }, out: join(tempDir(), "warn.mp4") });
    expect(result.warnings).toEqual([expect.stringContaining("is not spoken in any transcript")]);
    await finished(result.job.id);
  }, MEDIA_TIMEOUT);

  it("rejects a bad cover colour before queuing anything", async () => {
    await expect(conn.request("render", { cwd: project, cover: { color: "yellow" } } as never)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});

describe("a first clip that fades in from black", () => {
  it(
    "makes the default cover frame the first whole picture, never the black one, and keeps the black-frame warning quiet",
    async () => {
      await conn.request("transition.set", { cwd: project, at: 0, kind: "fade", duration: 0.5 });
      const cover = await conn.request("cover", { cwd: project, out: join(tempDir(), "fade.png") });
      expect(cover).toMatchObject({ source: "default", at: 0.5, warnings: [] });

      const result = await conn.request("render", { cwd: project, cover: {}, out: join(tempDir(), "fade.mp4") });
      expect(result.warnings).toEqual([]);
      await finished(result.job.id);

      const plain = await conn.request("render", { cwd: project, out: join(tempDir(), "plain-fade.mp4") });
      expect(plain.warnings).toEqual([expect.stringContaining("fades in from black")]);
      await finished(plain.job.id);
    },
    MEDIA_TIMEOUT,
  );
});
