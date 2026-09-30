import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

let daemon: Daemon;
let conn: DaemonConnection;
let dir: string;
beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath() });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  dir = tempDir();
  await conn.request("project.init", { dir, name: "Talk" });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("file.write", () => {
  it("writes a text file inside the project and reports its project-relative path", async () => {
    const path = join(dir, "scripts", "launch.md");
    const result = await conn.request("file.write", { path, content: "# Intro\n\nHello.\n" });
    expect(result).toEqual({ project: dir, path: "scripts/launch.md" });
    expect(readFileSync(path, "utf8")).toBe("# Intro\n\nHello.\n");
    // Atomic write leaves no temp file behind.
    expect(readdirSync(join(dir, "scripts"))).toEqual(["launch.md"]);
  });

  it("creates missing parent directories", async () => {
    const path = join(dir, "compositions", "hyperframes", "intro", "notes.md");
    await conn.request("file.write", { path, content: "x" });
    expect(readFileSync(path, "utf8")).toBe("x");
  });

  it("refuses a path outside any project", async () => {
    const outside = join(tempDir(), "notes.md");
    await expect(conn.request("file.write", { path: outside, content: "x" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
    expect(existsSync(outside)).toBe(false);
  });

  it("refuses daemon-owned state under .frameshell/", async () => {
    const path = join(dir, ".frameshell", "history", "main.jsonl");
    await expect(conn.request("file.write", { path, content: "{}" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
  });

  it("refuses .frameshell/ under any letter case", async () => {
    for (const name of [".FRAMESHELL", ".FrameShell"]) {
      const path = join(dir, name, "history", "main.jsonl");
      await expect(conn.request("file.write", { path, content: "pwn" })).rejects.toMatchObject({
        code: ErrorCode.OutsideProject,
      });
    }
    expect(existsSync(join(dir, ".frameshell", "history", "main.jsonl"))).toBe(false);
  });

  it("refuses a path escaping the project through a symlinked directory", async () => {
    const outside = tempDir();
    // Junction: directory link Windows creates without admin rights; ignored elsewhere.
    symlinkSync(outside, join(dir, "link"), "junction");
    for (const path of [join(dir, "link", "escape.md"), join(dir, "link", "new", "escape.md")]) {
      await expect(conn.request("file.write", { path, content: "x" })).rejects.toMatchObject({
        code: ErrorCode.OutsideProject,
      });
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses reaching .frameshell/ through a symlinked directory", async () => {
    symlinkSync(join(dir, ".frameshell"), join(dir, "state"), "junction");
    const path = join(dir, "state", "history", "main.jsonl");
    await expect(conn.request("file.write", { path, content: "pwn" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
    expect(existsSync(join(dir, ".frameshell", "history", "main.jsonl"))).toBe(false);
  });

  it("refuses to write through a symlinked file", async (ctx) => {
    const outside = join(tempDir(), "target.md");
    writeFileSync(outside, "before");
    try {
      symlinkSync(outside, join(dir, "notes.md"), "file");
    } catch {
      ctx.skip(); // Windows without symlink privilege.
    }
    await expect(conn.request("file.write", { path: join(dir, "notes.md"), content: "x" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
    expect(readFileSync(outside, "utf8")).toBe("before");
  });

  it("refuses a path escaping the project via ..", async () => {
    mkdirSync(join(dir, "assets"), { recursive: true });
    const path = `${join(dir, "assets")}/../../escape.md`;
    await expect(conn.request("file.write", { path, content: "x" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
  });

  it("rejects an invalid frameshell.json and keeps the old one", async () => {
    const path = join(dir, "frameshell.json");
    const before = readFileSync(path, "utf8");
    await expect(conn.request("file.write", { path, content: '{"name": 3}' })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("rejects a timeline that is not valid JSON", async () => {
    const path = join(dir, "timelines", "main.json");
    await expect(conn.request("file.write", { path, content: "{ nope" })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("main.json"),
    });
  });

  it("rejects a transcript edit that breaks its schema, so re-transcribing never meets a broken file", async () => {
    const path = join(dir, "transcripts", "raw-01.words.json");
    await expect(conn.request("file.write", { path, content: '{"schemaVersion": 1, "words": "oops"}' })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("words"),
    });
  });

  it("accepts a valid edit to frameshell.json", async () => {
    const path = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.name = "Renamed";
    await conn.request("file.write", { path, content: JSON.stringify(config, null, 2) });
    const status = await conn.request("status", { cwd: dir });
    expect(status.project?.name).toBe("Renamed");
  });
});
