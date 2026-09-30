import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, parsePluginSpec, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { type GitPlugin, gitPluginFixture } from "./plugin-fixture.js";

// Installs run real npm against local git repos: slow, never networked.
const NPM_TIMEOUT = 120_000;

const readConfig = (dir: string) => JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));

let daemon: Daemon;
let conn: DaemonConnection;
let hello: GitPlugin;

let daemonDirs: { dataDir: string; configDir: string };

beforeAll(async () => {
  hello = gitPluginFixture();
  daemonDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: daemonDirs });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
});
afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function newProject(): Promise<string> {
  const dir = tempDir();
  await conn.request("project.init", { dir });
  return dir;
}

describe("plugin.install", () => {
  it(
    "installs from a local git repo, pins the resolved commit and loads the plugin",
    async () => {
      const dir = await newProject();
      const result = await conn.request("plugin.install", { cwd: dir, spec: hello.spec });

      expect(result).toMatchObject({ dir, name: "hello-plugin", pin: `${hello.spec}#${hello.sha}` });
      expect(readConfig(dir).plugins).toEqual({ "hello-plugin": `${hello.spec}#${hello.sha}` });
      expect(existsSync(join(dir, ".frameshell/plugins/node_modules/hello-plugin/frameshell-plugin.json"))).toBe(true);
      expect(result.plugin).toMatchObject({
        status: "loaded",
        version: "0.1.0",
        apiVersion: "1",
        error: null,
        contributes: { commands: ["hello greet"], exportPresets: ["hello-square"] },
      });
      expect(result.plugin.contributes?.skills[0]).toMatch(/skills[/\\]hello[/\\]SKILL\.md$/);
      expect(methods["plugin.install"].result.parse(result)).toEqual(result);
    },
    NPM_TIMEOUT,
  );
});

describe("plugin contributions", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await newProject();
    await conn.request("plugin.install", { cwd: dir, spec: hello.spec });
  }, NPM_TIMEOUT);

  it("runs a plugin command with its arguments, from any directory in the project", async () => {
    const result = await conn.request("plugin.run", {
      cwd: join(dir, "assets"),
      plugin: "hello",
      command: "greet",
      args: ["Ana"],
    });
    expect(result).toEqual({ output: "Hello, Ana!", data: { greeted: "Ana", project: dir } });
  });

  it("reports a command that throws as PluginCommandFailed with its message", async () => {
    await expect(
      conn.request("plugin.run", { cwd: dir, plugin: "hello", command: "greet", args: ["--fail"] }),
    ).rejects.toMatchObject({ code: ErrorCode.PluginCommandFailed, message: expect.stringContaining("greeting refused") });
  });

  it("lists available commands when the command is unknown", async () => {
    await expect(conn.request("plugin.run", { cwd: dir, plugin: "hello", command: "wave" })).rejects.toMatchObject({
      code: ErrorCode.CommandNotFound,
      data: { command: "hello wave", available: ["hello greet"] },
    });
  });

  it("exposes the plugin's export preset", async () => {
    const { presets } = await conn.request("export.presets", { cwd: dir });
    expect(presets.filter((preset) => preset.plugin !== null)).toEqual([
      expect.objectContaining({ id: "hello-square", plugin: "hello-plugin", container: "mp4", loudness: -14 }),
    ]);
  });
});

describe("plugin agent skills", () => {
  const skillLink = (dir: string) => join(dir, ".claude", "skills", "hello");

  it(
    "exposes the plugin's skills in .claude/skills on install and takes them away on remove",
    async () => {
      const dir = await newProject();
      const installed = await conn.request("plugin.install", { cwd: dir, spec: hello.spec });

      expect(installed.skills).toEqual([".claude/skills/hello"]);
      expect(installed.warnings).toEqual([]);
      expect(readFileSync(join(skillLink(dir), "SKILL.md"), "utf8")).toContain("name: hello");
      expect(lstatSync(skillLink(dir)).isSymbolicLink()).toBe(true);

      const removed = await conn.request("plugin.remove", { cwd: dir, name: "hello-plugin" });
      expect(removed.skills).toEqual([".claude/skills/hello"]);
      expect(existsSync(skillLink(dir))).toBe(false);
      expect(lstatSync(join(dir, ".claude", "skills")).isDirectory()).toBe(true);
    },
    NPM_TIMEOUT,
  );

  it(
    "leaves a skill the user owns under the same name alone and says so",
    async () => {
      const dir = await newProject();
      mkdirSync(skillLink(dir), { recursive: true });
      writeFileSync(join(skillLink(dir), "SKILL.md"), "mine");

      const installed = await conn.request("plugin.install", { cwd: dir, spec: hello.spec });
      expect(installed.skills).toEqual([]);
      expect(installed.warnings).toEqual([expect.stringContaining(".claude/skills/hello")]);
      expect(readFileSync(join(skillLink(dir), "SKILL.md"), "utf8")).toBe("mine");

      await conn.request("plugin.remove", { cwd: dir, name: "hello-plugin" });
      expect(readFileSync(join(skillLink(dir), "SKILL.md"), "utf8")).toBe("mine");
    },
    NPM_TIMEOUT,
  );

  it(
    "relinks skills removed by hand when the plugins load again",
    async () => {
      const dir = await newProject();
      await conn.request("plugin.install", { cwd: dir, spec: hello.spec });
      rmSync(skillLink(dir));
      // A new daemon loads the project's plugins afresh, as after a restart or a fresh clone.
      const other = await startDaemon({ socketPath: uniqueSocketPath(), dirs: daemonDirs });
      const otherConn = await connectToDaemon(other.socketPath, { client: "test" });
      try {
        await otherConn.request("plugin.list", { cwd: dir });
        expect(readFileSync(join(skillLink(dir), "SKILL.md"), "utf8")).toContain("name: hello");
      } finally {
        otherConn.close();
        await other.close();
      }
    },
    NPM_TIMEOUT,
  );
});

describe("plugin validation at install", () => {
  it(
    "rejects a plugin built for another API version with a clear error and pins nothing",
    async () => {
      const future = gitPluginFixture({ apiVersion: "2" });
      const dir = await newProject();
      const attempt = conn.request("plugin.install", { cwd: dir, spec: future.spec });
      await expect(attempt).rejects.toMatchObject({
        code: ErrorCode.InvalidPlugin,
        message: expect.stringMatching(/plugin API v2.*supports v1.*upgrade Frameshell/s),
      });
      expect(readConfig(dir).plugins).toEqual({});
      expect(existsSync(join(dir, ".frameshell/plugins/node_modules/hello-plugin"))).toBe(false);
    },
    NPM_TIMEOUT,
  );

  it(
    "rejects a package whose manifest is invalid, naming the field",
    async () => {
      const broken = gitPluginFixture({ contributes: { commands: ["plugin hijack"] } });
      const dir = await newProject();
      await expect(conn.request("plugin.install", { cwd: dir, spec: broken.spec })).rejects.toMatchObject({
        code: ErrorCode.InvalidPlugin,
        message: expect.stringContaining("contributes.commands"),
      });
      expect(readConfig(dir).plugins).toEqual({});
    },
    NPM_TIMEOUT,
  );

  it.each(["./local/dir", "https://example.com/p.tgz", "github:no-repo", "Bad Name"])(
    "refuses spec %s before running npm",
    async (spec) => {
      const dir = await newProject();
      await expect(conn.request("plugin.install", { cwd: dir, spec })).rejects.toMatchObject({
        code: ErrorCode.InvalidPluginSpec,
      });
    },
  );

  it("parses github:, git+ and npm specs into what npm fetches and how the pin is built", () => {
    expect(parsePluginSpec("github:acme/titles.git#v1.2")).toEqual({
      kind: "git",
      spec: "github:acme/titles.git#v1.2",
      base: "github:acme/titles",
      ref: "v1.2",
    });
    expect(parsePluginSpec("git+https://example.com/acme/titles.git")).toMatchObject({
      kind: "git",
      base: "git+https://example.com/acme/titles.git",
      ref: null,
    });
    expect(parsePluginSpec("@acme/titles@^1.2.0")).toEqual({
      kind: "npm",
      spec: "@acme/titles@^1.2.0",
      name: "@acme/titles",
      range: "^1.2.0",
    });
    expect(parsePluginSpec("titles")).toMatchObject({ kind: "npm", name: "titles", range: null });
  });

  it("fails with ProjectNotFound outside a project", async () => {
    await expect(conn.request("plugin.install", { cwd: tempDir(), spec: hello.spec })).rejects.toMatchObject({
      code: ErrorCode.ProjectNotFound,
    });
  });
});
