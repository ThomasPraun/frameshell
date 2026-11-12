import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { CONFIG_JOURNAL, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { ffprobeJson, makeClip } from "./media-fixtures.js";
import { mediaTools, runBuffer, testBinaryManager } from "./media-tools.js";

// Formats of one project (ADR 0027): `format.*` edits frameshell.json, `render --formats` and `frame` lay out each one.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let original = "";

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  original = readFileSync(join(project, "frameshell.json"), "utf8");
  const footage = join(tempDir(), "wide.mp4");
  await makeClip(footage, { width: 320, height: 180, durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
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

/** Mean of the RGB bytes of the top row of an image file. */
async function topRowMean(path: string, width: number): Promise<number> {
  const { ffmpeg } = await mediaTools();
  const pixels = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const row = pixels.subarray(0, width * 3);
  return row.reduce((sum, value) => sum + value, 0) / row.length;
}

describe("formats of a project", () => {
  it("lists one format, the resolution, when frameshell.json declares none", async () => {
    const result = await conn.request("format.list", { cwd: project });
    expect(result.formats).toEqual([{ id: "16x9", width: 1920, height: 1080, primary: true, builtin: true }]);
    expect(result.builtins.map((format) => format.id)).toEqual(["16x9", "1x1", "4x5", "9x16"]);
  });

  it("adds built-in and custom formats, journaled, each with the call that undoes it", async () => {
    const vertical = await conn.request("format.add", { cwd: project, id: "9x16" });
    expect(vertical).toMatchObject({ dir: project, undo: { method: "format.remove", params: { id: "9x16" } } });
    expect(vertical.op).toMatch(/^op_[0-9a-f]{8}$/);
    const web = await conn.request("format.add", { cwd: project, id: "web-1600x900", width: 1600, height: 900, index: 1 });
    expect(web.formats.map((format) => format.id)).toEqual(["16x9", "web-1600x900", "9x16"]);
    const config = JSON.parse(readFileSync(join(project, "frameshell.json"), "utf8")) as Record<string, unknown>;
    // Written right after `resolution`, primary first.
    expect(Object.keys(config).indexOf("formats")).toBe(Object.keys(config).indexOf("resolution") + 1);
    expect(config["formats"]).toEqual([
      { id: "16x9", width: 1920, height: 1080 },
      { id: "web-1600x900", width: 1600, height: 900 },
      { id: "9x16", width: 1080, height: 1920 },
    ]);
    const journal = readFileSync(join(project, CONFIG_JOURNAL), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    // 9x16 moving down one place is no change of its own (ADR 0036): only the added key is patched.
    const keys = (entry: Record<string, unknown>) => (entry["patch"] as { key: string }[]).map((change) => change.key);
    expect(journal.map((entry) => [entry["op"], entry["author"], keys(entry)])).toEqual([
      ["format.add", "cli", ["format:9x16"]],
      ["format.add", "cli", ["format:web-1600x900"]],
    ]);
  });

  it.each([
    [{ id: "9x16" }, "exists"],
    [{ id: "story" }, "size"],
    [{ id: "story", width: 1081, height: 1920 }, "size"],
    [{ id: "1x1", width: 720, height: 720 }, "builtin size"],
  ])("refuses format.add %j (%s)", async (params, reason) => {
    await expect(conn.request("format.add", { cwd: project, ...params })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { op: "format.add", reason } });
  });

  it("refuses removing the primary format and names the formats for an unknown one", async () => {
    await expect(conn.request("format.remove", { cwd: project, id: "16x9" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "primary" } });
    await expect(conn.request("format.remove", { cwd: project, id: "4x5" })).rejects.toMatchObject({
      code: ErrorCode.FormatNotFound,
      data: { format: "4x5", available: ["16x9", "web-1600x900", "9x16"] },
    });
  });

  it(
    "captures a frame in a format: 9:16 filled by the 16:9 footage, cropped around the centre",
    async () => {
      const out = join(tempDir(), "vertical.png");
      const result = await conn.request("frame", { cwd: project, at: 0.5, out, projectFormat: "9x16" });
      expect(result).toMatchObject({ projectFormat: "9x16", width: 1080, height: 1920 });
      const png = readFileSync(out);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1920]);
      // Letterboxed, the top row would be black bars.
      expect(await topRowMean(out, 1080)).toBeGreaterThan(20);
      const primary = await conn.request("frame", { cwd: project, at: 0.5, out: join(tempDir(), "wide.png") });
      expect(primary).toMatchObject({ projectFormat: "16x9", width: 1920, height: 1080 });
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a preset of another aspect than the format (the format owns the frame)", async () => {
    await expect(conn.request("frame", { cwd: project, at: 0.5, out: join(tempDir(), "x.png"), preset: "vertical-1080x1920" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "frame", reason: "preset aspect", field: "preset" },
    });
    await expect(conn.request("render", { cwd: project, preset: "youtube-1080p", formats: ["9x16"] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("`frameshell render --formats 16x9`"),
    });
    await expect(conn.request("render", { cwd: project, formats: ["4x5"] })).rejects.toMatchObject({ code: ErrorCode.FormatNotFound });
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((j) => j.kind === "render")).toEqual([]);
  });

  it(
    "renders one file per format from the same edit, named <file>-<format>",
    async () => {
      const result = await conn.request("render", { cwd: project, formats: ["16x9", "9x16", "web-1600x900"] });
      const names = ["16x9", "9x16", "web-1600x900"].map((id) => join(project, "exports", `main-youtube-1080p-${id}.mp4`));
      expect(result.renders.map((render) => [render.format, render.output, render.width, render.height])).toEqual([
        ["16x9", names[0], 1920, 1080],
        ["9x16", names[1], 1080, 1920],
        ["web-1600x900", names[2], 1600, 900],
      ]);
      expect(result).toMatchObject({ format: "16x9", output: names[0], job: { id: result.renders[0]!.job.id } });
      for (const render of result.renders) expect((await finished(render.job.id)).state).toBe("done");
      for (const [index, size] of [[1920, 1080], [1080, 1920], [1600, 900]].entries()) {
        const { streams } = (await ffprobeJson(names[index]!, ["-select_streams", "v:0", "-show_entries", "stream=width,height"])) as { streams: { width: number; height: number }[] };
        expect([streams[0]!.width, streams[0]!.height]).toEqual(size);
      }
      // An explicit preset of the format's aspect sets the size, as before formats.
      const vertical = await conn.request("render", { cwd: project, preset: "vertical-1080x1920", formats: ["9x16"] });
      expect(vertical.renders[0]).toMatchObject({ output: join(project, "exports", "main-vertical-1080x1920-9x16.mp4"), width: 1080, height: 1920 });
      expect((await finished(vertical.job.id)).state).toBe("done");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "renders the primary at its own size when export.defaultPreset has another aspect, and warns",
    async () => {
      const file = join(project, "frameshell.json");
      const kept = readFileSync(file, "utf8");
      const config = JSON.parse(kept) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...config, export: { ...(config["export"] as object), defaultPreset: "vertical-1080x1920" } }, null, 2));
      try {
        const result = await conn.request("render", { cwd: project });
        expect(result).toMatchObject({ format: "16x9", preset: "vertical-1080x1920", width: 1920, height: 1080 });
        expect(result.warnings).toEqual([expect.stringContaining("Default preset vertical-1080x1920 (export.defaultPreset) is 1080x1920")]);
        expect(result.renders[0]!.warnings).toEqual(result.warnings);
        expect((await finished(result.job.id)).state).toBe("done");
        // Same aspect as the format: no warning.
        const vertical = await conn.request("render", { cwd: project, formats: ["9x16"] });
        expect(vertical.warnings).toEqual([]);
        expect((await finished(vertical.job.id)).state).toBe("done");
      } finally {
        writeFileSync(file, kept);
      }
    },
    MEDIA_TIMEOUT,
  );

  it("removes formats with an undo that restores the position; back to one, frameshell.json is as it was", async () => {
    const removed = await conn.request("format.remove", { cwd: project, id: "web-1600x900" });
    expect(removed.undo).toEqual({ method: "format.add", params: { id: "web-1600x900", width: 1600, height: 900, index: 1 } });
    await conn.request("format.add", { cwd: project, ...(removed.undo.params as { id: string }) });
    expect((await conn.request("format.list", { cwd: project })).formats.map((format) => format.id)).toEqual(["16x9", "web-1600x900", "9x16"]);
    await conn.request("format.remove", { cwd: project, id: "web-1600x900" });
    const last = await conn.request("format.remove", { cwd: project, id: "9x16" });
    expect(last.formats.map((format) => format.id)).toEqual(["16x9"]);
    expect(readFileSync(join(project, "frameshell.json"), "utf8")).toBe(original);
  });

  it("refuses formats in an image project", async () => {
    const image = tempDir();
    await conn.request("project.init", { dir: image, kind: "image" });
    await expect(conn.request("format.add", { cwd: image, id: "9x16" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "image project" } });
  });
});
