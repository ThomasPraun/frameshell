import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { parseProjectConfig, parseTimeline } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

let daemon: Daemon;
let conn: DaemonConnection;
beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath() });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("project.init", () => {
  it("scaffolds the SPEC §5.1 layout with a valid config and main timeline", async () => {
    const dir = join(tempDir(), "my-video");
    const { project } = await conn.request("project.init", { dir, name: "Launch video" });

    expect(project).toEqual({ dir, name: "Launch video", schemaVersion: 1 });
    for (const sub of ["timelines", "scripts", "assets", "compositions", "transcripts", ".frameshell/history"]) {
      expect(existsSync(join(dir, sub)), sub).toBe(true);
    }
    const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));
    expect(parseProjectConfig(config).ok).toBe(true);
    expect(config.schemaVersion).toBe(1);
    const timeline = JSON.parse(readFileSync(join(dir, "timelines/main.json"), "utf8"));
    expect(parseTimeline(timeline)).toMatchObject({ ok: true, value: { id: "main", revision: 0 } });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".frameshell/");
  });

  it("names the project after its directory by default", async () => {
    const dir = join(tempDir(), "demo-reel");
    const { project } = await conn.request("project.init", { dir });
    expect(project.name).toBe("demo-reel");
  });

  it("installs the Frameshell agent skill, the same files as skills/frameshell (run `pnpm gen:skill` after editing it)", async () => {
    const dir = tempDir();
    const { created } = await conn.request("project.init", { dir });

    const repoSkill = fileURLToPath(new URL("../../../skills/frameshell/", import.meta.url));
    const skillFiles = readdirSync(repoSkill, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".md"));
    expect(skillFiles).toContain("SKILL.md");
    for (const file of skillFiles) {
      const installed = join(dir, ".claude", "skills", "frameshell", file);
      // Windows checkouts may turn LF into CRLF.
      expect(readFileSync(installed, "utf8"), file).toBe(readFileSync(join(repoSkill, file), "utf8").replace(/\r\n/g, "\n"));
      expect(created).toContain(`.claude/skills/frameshell/${file.split(sep).join("/")}`);
    }
  });

  it("leaves the agent skill out with agentSkill: false, and keeps one already there", async () => {
    const without = tempDir();
    const { created } = await conn.request("project.init", { dir: without, agentSkill: false });
    expect(existsSync(join(without, ".claude"))).toBe(false);
    expect(created.some((path) => path.startsWith(".claude/"))).toBe(false);

    const customized = tempDir();
    mkdirSync(join(customized, ".claude", "skills", "frameshell"), { recursive: true });
    writeFileSync(join(customized, ".claude", "skills", "frameshell", "SKILL.md"), "tuned by the user");
    const second = await conn.request("project.init", { dir: customized });
    expect(readFileSync(join(customized, ".claude", "skills", "frameshell", "SKILL.md"), "utf8")).toBe("tuned by the user");
    expect(second.created.some((path) => path.startsWith(".claude/"))).toBe(false);
  });

  it("refuses to overwrite an existing project", async () => {
    const dir = tempDir();
    await conn.request("project.init", { dir });
    await expect(conn.request("project.init", { dir })).rejects.toMatchObject({ code: ErrorCode.ProjectExists });
  });
});

describe("status", () => {
  it("reports the project enclosing cwd, searching upwards", async () => {
    const dir = tempDir();
    await conn.request("project.init", { dir, name: "Talk" });
    const status = await conn.request("status", { cwd: join(dir, "assets") });
    expect(status.project).toEqual({ dir, name: "Talk", schemaVersion: 1 });
    expect(status.openProjects).toContainEqual(status.project);
    expect(status.daemon).toMatchObject({ pid: process.pid, clients: 1, socketPath: daemon.socketPath });
  });

  it("reports no project outside any project directory", async () => {
    const status = await conn.request("status", { cwd: tempDir() });
    expect(status.project).toBeNull();
  });

  it("explains which field of an invalid frameshell.json is wrong", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ schemaVersion: 1, name: "x" }));
    await expect(conn.request("status", { cwd: dir })).rejects.toMatchObject({
      code: ErrorCode.InvalidProjectFile,
      message: expect.stringContaining("fps"),
    });
  });
});

describe("declared result schemas", () => {
  // parse() strips undeclared keys, so equality proves the schema lists every field the daemon sends.
  it("match what the daemon actually returns", async () => {
    const dir = tempDir();
    const init = await conn.request("project.init", { dir });
    expect(methods["project.init"].result.parse(init)).toEqual(init);
    const status = await conn.request("status", { cwd: dir });
    expect(methods.status.result.parse(status)).toEqual(status);
    expect(methods.handshake.result.parse(conn.daemon)).toEqual(conn.daemon);
  });
});
