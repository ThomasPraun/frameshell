import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
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
