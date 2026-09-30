import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { ffprobeJson, makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Daemon wiring: presets, validation before queuing, the render job and frame capture on a 1 s project.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let video = "";

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = join(tempDir(), "take.mp4");
  await makeClip(footage, { durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1 });
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

describe("render and frame methods", () => {
  it("lists the built-in presets", async () => {
    const { presets } = await conn.request("export.presets", { cwd: project });
    expect(presets.map((p) => [p.id, p.plugin, p["video"]])).toEqual([
      ["youtube-1080p", null, expect.objectContaining({ codec: "h264", width: 1920, height: 1080 })],
      ["youtube-1440p", null, expect.objectContaining({ width: 2560, height: 1440 })],
      ["vertical-1080x1920", null, expect.objectContaining({ width: 1080, height: 1920 })],
    ]);
  });

  it("rejects an unknown preset before queuing anything, listing the available ones", async () => {
    await expect(conn.request("render", { cwd: project, preset: "dvd" })).rejects.toMatchObject({
      code: ErrorCode.PresetNotFound,
      data: { preset: "dvd", available: ["youtube-1080p", "youtube-1440p", "vertical-1080x1920"] },
    });
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((j) => j.kind === "render")).toEqual([]);
  });

  it("rejects an empty timeline as ExportUnsupported", async () => {
    await conn.request("file.write", {
      path: join(project, "timelines", "empty.json"),
      content: JSON.stringify({ schemaVersion: 1, id: "empty", revision: 0, tracks: [] }),
    });
    await expect(conn.request("render", { cwd: project, timeline: "empty" })).rejects.toMatchObject({
      code: ErrorCode.ExportUnsupported,
    });
  });

  it(
    "renders the main timeline as a job to exports/<timeline>-<preset>.mp4",
    async () => {
      const result = await conn.request("render", { cwd: project, preset: "vertical-1080x1920" });
      const output = join(project, "exports", "main-vertical-1080x1920.mp4");
      expect(result).toMatchObject({
        output,
        preset: "vertical-1080x1920",
        timeline: "main",
        duration: 1,
        width: 1080,
        height: 1920,
        fps: "30/1",
        loudness: -17,
        warnings: [],
        job: { kind: "render", asset: "timelines/main.json", output },
      });
      const job = await finished(result.job.id);
      expect(job).toMatchObject({ state: "done", error: null, progress: 1 });
      const { streams } = (await ffprobeJson(output, ["-show_entries", "stream=codec_type,codec_name,width,height,duration"])) as {
        streams: { codec_type: string; codec_name: string; width?: number; height?: number; duration: string }[];
      };
      expect(streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
        ["video", "h264"],
        ["audio", "aac"],
      ]);
      expect(streams[0]).toMatchObject({ width: 1080, height: 1920 });
      expect(Number(streams[0]!.duration)).toBeCloseTo(1, 2);
      // No scratch files left behind.
      const scratch = join(project, ".frameshell", "cache", "render");
      expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "captures a frame as PNG at the project resolution",
    async () => {
      const out = join(tempDir(), "shots", "half.png");
      const result = await conn.request("frame", { cwd: project, at: 0.5, out });
      expect(result).toMatchObject({ path: out, frame: 15, at: 0.5, width: 1920, height: 1080, timeline: "main" });
      const png = readFileSync(out);
      expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a frame past the end with the valid range", async () => {
    await expect(conn.request("frame", { cwd: project, at: 5, out: join(tempDir(), "x.png") })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "frame", valid: { min: 0, max: 0.967 } },
    });
  });

  it(
    "flattens nested timelines: a timeline clip exports the clips it plays",
    async () => {
      const main = await conn.request("timeline.show", { cwd: project });
      const inner = main.tracks[0]!.clips[0]!.id;
      // Plays main from 0.5 s for 0.4 s, half size, from 0.2 s.
      const outer = {
        schemaVersion: 1,
        id: "outer",
        revision: 0,
        tracks: [
          {
            id: "v1",
            kind: "video",
            clips: [{ id: "c_nest", type: "timeline", source: "timelines/main.json", start: 0.2, in: 0.5, duration: 0.4, transform: { scale: 0.5 } }],
          },
        ],
      };
      await conn.request("file.write", { path: join(project, "timelines", "outer.json"), content: JSON.stringify(outer) });
      const shot = await conn.request("frame", { cwd: project, timeline: "outer", at: 0.3, out: join(tempDir(), "nested.png") });
      // The nested clip's clips land on its track, renamed after it.
      expect(shot).toMatchObject({ frame: 9, clip: `c_nest/${inner}` });
      const result = await conn.request("render", { cwd: project, timeline: "outer" });
      expect(result).toMatchObject({ duration: 0.6, timeline: "outer" });
      expect((await finished(result.job.id)).state).toBe("done");

      outer.tracks[0]!.clips[0]!.source = "timelines/gone.json";
      await conn.request("file.write", { path: join(project, "timelines", "outer.json"), content: JSON.stringify(outer) });
      await expect(conn.request("render", { cwd: project, timeline: "outer" })).rejects.toMatchObject({
        code: ErrorCode.ExportUnsupported,
        message: expect.stringContaining("timelines/gone.json"),
      });
    },
    MEDIA_TIMEOUT,
  );
});
