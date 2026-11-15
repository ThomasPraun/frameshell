import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BatchManifest, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, standInSpeechProvider, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { ffprobeJson, makeClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// Batch voiceover rows and CSV rows (ADR 0040) through the daemon with the stand-in voice: a row's `voiceover` slot
// places the takes of its script as phrase clips on the row's variant, in memory, with the planner of `voiceover.place`.
const TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let timelineBytes = "";

const script = (lines: string[]) => ["---", "title: Launch", "voiceover: true", "language: en", "provider: stand-in", "---", ...lines].join("\n");

function write(name: string, content: string): string {
  const path = join(project, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function writeBatch(name: string, content: Record<string, unknown>): void {
  write(`${name}.batch.json`, JSON.stringify({ schemaVersion: 1, slots: { voice: "voiceover" }, ...content }));
}

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
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    speechProviders: [standInSpeechProvider()],
    dirs: { dataDir: tempDir(), configDir: tempDir() },
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const configPath = join(project, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
  const picture = join(tempDir(), "picture.mp4");
  await makeClip(picture, { width: 64, height: 36, durationS: 1 });
  const asset = (await conn.request("asset.import", { cwd: project, files: [picture] })).imported[0]!.asset;
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset, start: 0, in: 0, out: 1 });
  // Two lines of three and two phrases for Spanish; the French script has no takes.
  write("scripts/launch-es.md", script(["## Hook", "Uno dos tres.", "Cuatro cinco."]));
  write("scripts/launch-fr.md", script(["## Hook", "Un deux trois."]));
  await conn.request("voiceover.generate", { cwd: project, script: "scripts/launch-es.md", verify: false });
  timelineBytes = readFileSync(join(project, "timelines", "main.json"), "utf8");
}, TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

describe("batch voiceover rows", () => {
  it("places the takes of a row's script on its variant: warns the video grows, writes no timeline and no history", async () => {
    writeBatch("launch", { rows: [{ id: "es", voice: "scripts/launch-es.md" }, { id: "plain" }] });
    const result = await conn.request("batch.render", { cwd: project, file: "launch.batch.json", dryRun: true });
    expect(result.entries.map((entry) => [entry.row, entry.status])).toEqual([
      ["es", "planned"],
      ["plain", "planned"],
    ]);
    expect(result.entries[0]!.warnings).toEqual([expect.stringMatching(/^The voiceover makes the video \d+(\.\d+)? s long, \d+(\.\d+)? s longer than the template's 1 s\./)]);
    // A row with no voiceover value keeps the template as it is.
    expect(result.entries[1]!.warnings).toEqual([]);
    expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(timelineBytes);
    expect((await conn.request("history", { cwd: project, timeline: "main" })).transactions.filter((tx) => (tx.label ?? "").startsWith("Voiceover"))).toEqual([]);
  });

  it("takes the object form with lines, and the rows of a CSV file next to the batch file", async () => {
    write("launch.csv", "id,voice\nes,scripts/launch-es.md\n");
    writeBatch("fromcsv", { csv: "launch.csv" });
    const fromCsv = await conn.request("batch.render", { cwd: project, file: "fromcsv.batch.json", dryRun: true });
    expect(fromCsv.entries.map((entry) => [entry.row, entry.output])).toEqual([["es", join(project, "exports", "fromcsv", "es.mp4")]]);
    expect(fromCsv.entries[0]!.warnings[0]).toContain("The voiceover makes the video");

    writeBatch("lines", { rows: [{ id: "only", voice: { script: "scripts/launch-es.md", lines: ["hook-2"], gap: 0.1 } }] });
    const lines = await conn.request("batch.render", { cwd: project, file: "lines.batch.json", dryRun: true });
    expect(lines.entries).toHaveLength(1);
  });

  it(
    "renders a row's voiceover into its file",
    async () => {
      writeBatch("render", { quality: "draft", rows: [{ id: "es", voice: "scripts/launch-es.md" }] });
      await conn.request("batch.render", { cwd: project, file: "render.batch.json" });
      const out = join(project, "exports", "render");
      const manifest = await ended(join(out, "manifest.json"));
      expect(manifest.entries.map((entry) => [entry.row, entry.status, entry.error])).toEqual([["es", "done", null]]);
      // The picture lasts 1 s; the placed voice runs past it, and the file is as long as the voice.
      const probe = await ffprobeJson(join(out, "es.mp4"), ["-show_entries", "format=duration"]);
      expect(Number((probe["format"] as { duration: string }).duration)).toBeGreaterThan(1.5);
      expect(readFileSync(join(project, "timelines", "main.json"), "utf8")).toBe(timelineBytes);
    },
    TIMEOUT,
  );

  it.each([
    [{ id: "fr", voice: "scripts/launch-fr.md" }, "voice", /no take for hook-1/],
    [{ id: "nope", voice: "scripts/missing.md" }, "voice", /No script scripts\/missing\.md/],
    [{ id: "bad", voice: { script: "scripts/launch-es.md", lines: ["zzz-9"] } }, "voice", /No line zzz-9/],
    [{ id: "late", voice: { script: "scripts/launch-es.md", at: { "hook-1": 0, "hook-2": 0 } } }, "voice", /overlap itself/],
  ])("refuses row %j before anything renders, naming the row and slot", async (bad, slot, message) => {
    writeBatch("broken", { rows: [{ id: "ok", voice: "scripts/launch-es.md" }, bad] });
    await expect(conn.request("batch.render", { cwd: project, file: "broken.batch.json" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringMatching(message),
      data: { op: "batch.render", row: bad.id, slot },
    });
    expect(existsSync(join(project, "exports", "broken"))).toBe(false);
  });

  it("fails a voiceover that is not a script path or an object, and a batch with two voiceover slots", async () => {
    writeBatch("typed", { rows: [{ id: "es", voice: 3 }] });
    await expect(conn.request("batch.render", { cwd: project, file: "typed.batch.json", dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("rows.0.voice: a voiceover slot takes a voiceover script path"),
    });
    writeBatch("two", { slots: { a: "voiceover", b: "voiceover" }, rows: [{ id: "es" }] });
    await expect(conn.request("batch.render", { cwd: project, file: "two.batch.json", dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("at most one slot may be `voiceover`"),
    });
  });

  it("reports every wrong CSV cell with its line and column, and a missing CSV file", async () => {
    write("bad.csv", "id,voyce,voice\nes,x,scripts/launch-es.md\nES,,\nes2,,\nes2,,\n");
    writeBatch("badcsv", { csv: "bad.csv" });
    await expect(conn.request("batch.render", { cwd: project, file: "badcsv.batch.json", dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringMatching(/line 1, column voyce: unknown slot voyce[\s\S]*line 3, column id: "ES" must be lowercase/),
    });
    write("dup.csv", "id,voice\nes,scripts/launch-es.md\nes,scripts/launch-es.md\n");
    writeBatch("dupcsv", { csv: "dup.csv" });
    await expect(conn.request("batch.render", { cwd: project, file: "dupcsv.batch.json", dryRun: true })).rejects.toMatchObject({
      message: expect.stringContaining("line 3, column id: row id es is used twice (line 2)"),
    });
    writeBatch("nocsv", { csv: "missing.csv" });
    await expect(conn.request("batch.render", { cwd: project, file: "nocsv.batch.json", dryRun: true })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    writeBatch("both", { csv: "launch.csv", rows: [{ id: "es" }] });
    await expect(conn.request("batch.render", { cwd: project, file: "both.batch.json", dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("give `rows`"),
    });
  });

  it("needs a transcript of every take when a subtitle track follows the voice track", async () => {
    const voice = (await conn.request("track.add", { cwd: project, kind: "audio", name: "Voiceover" })).changes.added[0]!;
    await conn.request("track.add", { cwd: project, kind: "subtitles", follows: voice });
    writeBatch("subs", { rows: [{ id: "es", voice: "scripts/launch-es.md" }] });
    await expect(conn.request("batch.render", { cwd: project, file: "subs.batch.json", dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringMatching(/subtitle track t_\w+ follows track t_\w+, but assets\/voiceover\/launch-es\/hook-1\.wav has no transcript/),
      data: { row: "es", slot: "voice", reason: "no transcript" },
    });
  });
});
