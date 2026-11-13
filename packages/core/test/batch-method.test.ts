import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BatchManifest, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { ffprobeJson, makeClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// Batch renders (ADR 0040) through the daemon: a `card` clip whose props a row sets and a voice clip whose asset a
// row swaps, validated up front, rendered one row at a time with the real managed ffmpeg, followed in manifest.json.
const TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let card = "";
let voice = "";
let timelineBytes = "";

function writeBatch(name: string, content: Record<string, unknown>): string {
  const path = join(project, `${name}.batch.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, slots: { title: `${card}.props.label`, voice: `${voice}.asset` }, ...content }));
  return path;
}

async function imported(name: string, options: Parameters<typeof makeClip>[1]): Promise<string> {
  const file = join(tempDir(), name);
  await makeClip(file, options);
  return (await conn.request("asset.import", { cwd: project, files: [file] })).imported[0]!.asset;
}

/** The manifest once its batch has ended. */
async function ended(path: string): Promise<BatchManifest> {
  for (const deadline = Date.now() + 150_000; Date.now() < deadline; ) {
    const manifest = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BatchManifest) : null;
    if (manifest?.state === "done") return manifest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${path} never said done`);
}

beforeAll(async () => {
  await mediaTools();
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const configPath = join(project, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
  installLocalPlugin(project, CARD_PLUGIN, "card-plugin");
  await conn.request("project.trust", { cwd: project, decision: "trust" });
  await conn.request("file.write", { path: join(project, "compositions", "cards", "red.json"), content: JSON.stringify({ color: "red", seconds: 1 }) });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  card = (await conn.request("clip.add", { cwd: project, track: video, type: "card", source: "compositions/cards/red.json", start: 0, duration: 1, props: { label: "Launch" } }))
    .changes.added[0]!;
  const english = await imported("vo-en.mp4", { width: 64, height: 36, durationS: 1 });
  const audio = (await conn.request("track.add", { cwd: project, kind: "audio" })).changes.added[0]!;
  voice = (await conn.request("clip.add", { cwd: project, track: audio, asset: english, start: 0, in: 0, out: 1 })).changes.added[0]!;
  await imported("vo-es.mp4", { width: 64, height: 36, durationS: 2 });
  await imported("short.mp4", { width: 64, height: 36, durationS: 0.5 });
  await imported("mute.mp4", { width: 64, height: 36, durationS: 2, silent: true });
  timelineBytes = readFileSync(join(project, "timelines", "main.json"), "utf8");
}, TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

describe("batch.render", () => {
  it("plans every row in a dry run: outputs under exports/<batch name>/, nothing queued or written", async () => {
    const file = writeBatch("launch", { rows: [{ id: "es", title: "Hola", voice: "assets/vo-es.mp4" }, { id: "en" }] });
    const result = await conn.request("batch.render", { cwd: project, file: "launch.batch.json", dryRun: true });
    const out = join(project, "exports", "launch");
    expect(result).toMatchObject({ dir: project, file, template: "main", out, manifest: null, dryRun: true, preset: "youtube-1080p", jobs: [] });
    expect(result.entries.map((entry) => [entry.row, entry.format, entry.output, entry.status, entry.job])).toEqual([
      ["es", "64x36", join(out, "es.mp4"), "planned", null],
      ["en", "64x36", join(out, "en.mp4"), "planned", null],
    ]);
    expect(existsSync(out)).toBe(false);
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((job) => job.kind === "render")).toEqual([]);
  });

  it.each([
    [{ id: "bad", title: 5 }, "title", "props refused", /Row bad, slot title: .*invalid props for card: label: must be a string/],
    [{ id: "bad", voice: "assets/short.mp4" }, "voice", "asset too short", /lasts 0\.5\d* s, shorter than .*out 1 s/],
    [{ id: "bad", voice: "assets/mute.mp4" }, "voice", "no audio stream", /has no audio stream/],
    [{ id: "bad", voice: "assets/missing.mp4" }, "voice", "asset unreadable", /missing\.mp4/],
  ])("refuses row %j before rendering any row, naming row and slot", async (bad, slot, reason, message) => {
    writeBatch("broken", { rows: [{ id: "ok", title: "Fine" }, bad] });
    await expect(conn.request("batch.render", { cwd: project, file: "broken.batch.json" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringMatching(message),
      data: { op: "batch.render", row: "bad", slot, reason },
    });
    expect(existsSync(join(project, "exports", "broken"))).toBe(false);
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((job) => job.kind === "render")).toEqual([]);
  });

  it("refuses a slot naming a clip the template does not have, and an invalid batch file", async () => {
    const path = join(project, "typo.batch.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, slots: { title: "c_nope.props.label" }, rows: [{ id: "a", title: "x" }] }));
    await expect(conn.request("batch.render", { cwd: project, file: path, dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { row: "a", slot: "title", reason: "clip not found" },
    });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, slots: { title: `${card}.props.label` }, rows: [{ id: "a" }, { id: "a" }] }));
    await expect(conn.request("batch.render", { cwd: project, file: path, dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("row id a is used twice"),
    });
    await expect(conn.request("batch.render", { cwd: project, file: "none.batch.json", dryRun: true })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
  });

  it(
    "renders the rows one at a time as render jobs, keeps manifest.json current, and never touches timelines/",
    async () => {
      writeBatch("launch", { quality: "draft", rows: [{ id: "es", title: "Hola", voice: "assets/vo-es.mp4" }, { id: "en" }] });
      const result = await conn.request("batch.render", { cwd: project, file: "launch.batch.json" });
      const out = join(project, "exports", "launch");
      const manifestPath = join(out, "manifest.json");
      expect(result).toMatchObject({ manifest: manifestPath, dryRun: false, quality: "draft" });
      // Only the first row is queued by the call; the second waits for it.
      expect(result.jobs.map((job) => [job.kind, job.output])).toEqual([["render", join(out, "es.mp4")]]);
      expect(result.entries.map((entry) => [entry.row, entry.job === null])).toEqual([
        ["es", false],
        ["en", true],
      ]);
      await expect(conn.request("batch.render", { cwd: project, file: "launch.batch.json" })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { reason: "batch running" },
      });

      const manifest = await ended(manifestPath);
      expect(manifest).toMatchObject({ template: "main", out, state: "done" });
      expect(manifest.entries.map((entry) => [entry.row, entry.status, entry.error])).toEqual([
        ["es", "done", null],
        ["en", "done", null],
      ]);
      for (const entry of manifest.entries) {
        expect(entry.duration).toBeGreaterThan(0);
        expect(existsSync(entry.output)).toBe(true);
      }
      // One row at a time: the second started after the first ended.
      expect(Date.parse(manifest.entries[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(manifest.entries[0]!.finishedAt!));
      const probe = await ffprobeJson(join(out, "es.mp4"), ["-show_entries", "format=duration"]);
      expect(Number((probe["format"] as { duration: string }).duration)).toBeCloseTo(1, 0);
      expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(timelineBytes);
      expect(readdirSync(join(project, "timelines"))).toEqual(["main.json"]);
    },
    TIMEOUT,
  );

  it("renders every row in each format of the project the batch lists", async () => {
    await conn.request("format.add", { cwd: project, id: "9x16" });
    writeBatch("sizes", { formats: ["64x36", "9x16"], rows: [{ id: "es", title: "Hola" }] });
    const result = await conn.request("batch.render", { cwd: project, file: "sizes.batch.json", dryRun: true });
    const out = join(project, "exports", "sizes");
    expect(result.entries.map((entry) => [entry.format, entry.output])).toEqual([
      ["64x36", join(out, "es-64x36.mp4")],
      ["9x16", join(out, "es-9x16.mp4")],
    ]);
    const override = await conn.request("batch.render", { cwd: project, file: "sizes.batch.json", formats: ["9x16"], out: join(project, "deliver"), dryRun: true });
    expect(override.entries.map((entry) => entry.output)).toEqual([join(project, "deliver", "es-9x16.mp4")]);
    await expect(conn.request("batch.render", { cwd: project, file: "sizes.batch.json", formats: ["4x5"], dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.FormatNotFound,
      data: { row: "es" },
    });
  });
});
