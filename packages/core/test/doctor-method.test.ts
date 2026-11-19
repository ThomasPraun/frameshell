import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { BinaryManager, type Daemon, FFMPEG_PACKAGE, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

let daemon: Daemon;
let conn: DaemonConnection;
let dataDir: string;
beforeEach(async () => {
  dataDir = tempDir();
  const binaries = new BinaryManager({ dataDir, configDir: tempDir(), packages: [FFMPEG_PACKAGE] });
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("doctor method", () => {
  it("reports pinned managed ffmpeg and ffprobe without downloading them", async () => {
    const report = await conn.request("doctor", { cwd: tempDir() });
    expect(report.dataDir).toBe(dataDir);
    expect(report.binaries.map((b) => [b.name, b.source, b.installed])).toEqual([
      ["ffmpeg", "managed", false],
      ["ffprobe", "managed", false],
    ]);
    expect(report.problems.join("\n")).toMatch(/not installed|No managed ffmpeg build/);
  });

  it("applies binaries overrides from the project enclosing cwd", async () => {
    const dir = tempDir();
    await conn.request("project.init", { dir });
    const configPath = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, binaries: { ffmpeg: "tools/ffmpeg" } }));

    const report = await conn.request("doctor", { cwd: join(dir, "assets") });
    expect(report.binaries[0]).toMatchObject({ source: "project", path: join(dir, "tools", "ffmpeg"), installed: false });
    expect(report.binaries[1]).toMatchObject({ source: "project", path: join(dir, "tools", "ffprobe") });
  });

  it("rejects a relative cwd as InvalidParams", async () => {
    await expect(conn.request("doctor", { cwd: "relative" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});

describe("binaries.remove method", () => {
  it("lists downloads in doctor, frees one by name, and is idempotent", async () => {
    mkdirSync(join(dataDir, "binaries", "ffmpeg", "9.0.2", "x"), { recursive: true });
    writeFileSync(join(dataDir, "binaries", "ffmpeg", "9.0.2", "x", "ffmpeg"), "x".repeat(2048));

    const before = await conn.request("doctor", { cwd: tempDir() });
    expect(before.downloads).toEqual([{ name: "ffmpeg", kind: "package", tools: ["ffmpeg", "ffprobe"], versions: ["9.0.2"], bytes: 2048 }]);

    const result = await conn.request("binaries.remove", { name: "ffmpeg" });
    expect(methods["binaries.remove"].result.parse(result)).toEqual(result);
    expect(result).toEqual({ name: "ffmpeg", kind: "package", removed: true, versions: ["9.0.2"], bytes: 2048 });
    expect((await conn.request("doctor", { cwd: tempDir() })).downloads).toEqual([]);
    expect(await conn.request("binaries.remove", { name: "ffmpeg" })).toMatchObject({ removed: false, bytes: 0 });
  });

  it("rejects a name that is not a managed download", async () => {
    await expect(conn.request("binaries.remove", { name: "blender" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});

describe("binaries.remove while jobs run", () => {
  it("refuses with BinaryInUse until the job is over", async () => {
    // An ingest job parked on ffmpeg stands for any running work.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => (release = resolve));
    class ParkedManager extends BinaryManager {
      override async ensure(...args: Parameters<BinaryManager["ensure"]>): Promise<string> {
        if (args[0] !== "ffmpeg") return super.ensure(...args);
        await parked;
        throw new Error("no ffmpeg in this test");
      }
    }
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    const busy = await startDaemon({ socketPath: uniqueSocketPath(), dirs, binaries: new ParkedManager({ ...dirs, packages: [FFMPEG_PACKAGE] }), idleTimeoutMs: Infinity });
    const link = await connectToDaemon(busy.socketPath, { client: "test" });
    try {
      const dir = tempDir();
      await link.request("project.init", { dir });
      const file = join(tempDir(), "clip.mp4");
      writeFileSync(file, "not a real video");
      await link.request("asset.import", { cwd: dir, files: [file], mode: "copy" });

      await expect(link.request("binaries.remove", { name: "ffmpeg" })).rejects.toMatchObject({ code: ErrorCode.BinaryInUse, data: { name: "ffmpeg", reason: "busy" } });
      release();
      for (let tries = 0; tries < 100 && (await link.request("job.list", { cwd: dir, active: true })).jobs.length > 0; tries++) await new Promise((r) => setTimeout(r, 50));
      expect(await link.request("binaries.remove", { name: "ffmpeg" })).toMatchObject({ removed: false });
    } finally {
      release();
      link.close();
      await busy.close();
    }
  });
});
