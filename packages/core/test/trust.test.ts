import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type AppDirs, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { type GitPlugin, gitPluginFixture } from "./plugin-fixture.js";

const NPM_TIMEOUT = 120_000;

const daemons: Daemon[] = [];
const conns: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of conns.splice(0)) conn.close();
  await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** A daemon with its own app dirs: a user who has never seen the project. */
async function daemonFor(
  dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() },
): Promise<{ conn: DaemonConnection; dirs: AppDirs }> {
  const daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs });
  daemons.push(daemon);
  const conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  conns.push(conn);
  return { conn, dirs };
}

let hello: GitPlugin;
beforeAll(() => {
  hello = gitPluginFixture();
});

/** Project whose author installed hello-plugin: pinned and installed, trusted only by the author. */
async function projectFromAuthor(): Promise<string> {
  const { conn } = await daemonFor();
  const dir = tempDir();
  await conn.request("project.init", { dir });
  await conn.request("plugin.install", { cwd: dir, spec: hello.spec });
  return dir;
}

const greet = (conn: DaemonConnection, dir: string) =>
  conn.request("plugin.run", { cwd: dir, plugin: "hello", command: "greet", args: ["Ana"] });

describe("project trust", () => {
  it("reports no trust needed for a project without plugins", async () => {
    const { conn } = await daemonFor();
    const dir = tempDir();
    await conn.request("project.init", { dir });
    expect((await conn.request("status", { cwd: dir })).trust).toEqual({ state: "not-required", plugins: {} });
  });

  it(
    "keeps plugins of an unknown project unloaded until the user trusts it",
    async () => {
      const dir = await projectFromAuthor();
      const { conn } = await daemonFor();

      const status = await conn.request("status", { cwd: dir });
      expect(status.trust).toMatchObject({ state: "unknown", plugins: { "hello-plugin": expect.any(String) } });
      const list = await conn.request("plugin.list", { cwd: dir });
      expect(list.plugins).toEqual([expect.objectContaining({ name: "hello-plugin", status: "untrusted", contributes: null })]);
      await expect(greet(conn, dir)).rejects.toMatchObject({
        code: ErrorCode.ProjectNotTrusted,
        message: expect.stringContaining("--trust"),
      });
      expect((await conn.request("export.presets", { cwd: dir })).presets).toEqual([]);

      expect(await conn.request("project.trust", { cwd: dir, decision: "trust" })).toMatchObject({ trust: "trusted" });
      expect((await greet(conn, dir)).output).toBe("Hello, Ana!");
    },
    NPM_TIMEOUT,
  );

  it(
    "remembers a denial, and trusting later still works",
    async () => {
      const dir = await projectFromAuthor();
      const { conn } = await daemonFor();
      expect(await conn.request("project.trust", { cwd: dir, decision: "deny" })).toMatchObject({ trust: "denied" });
      await expect(greet(conn, dir)).rejects.toMatchObject({
        code: ErrorCode.ProjectNotTrusted,
        message: expect.stringContaining("denied"),
      });
      await conn.request("project.trust", { cwd: dir, decision: "trust" });
      expect((await greet(conn, dir)).output).toBe("Hello, Ana!");
    },
    NPM_TIMEOUT,
  );

  it(
    "persists the decision in the user's config dir across daemon restarts",
    async () => {
      const dir = await projectFromAuthor();
      const first = await daemonFor();
      await first.conn.request("project.trust", { cwd: dir, decision: "trust" });
      expect(existsSync(join(first.dirs.configDir, "trust.json"))).toBe(true);
      expect(existsSync(join(first.dirs.dataDir, "trust.json"))).toBe(false);

      const again = await daemonFor(first.dirs);
      expect((await again.conn.request("status", { cwd: dir })).trust?.state).toBe("trusted");
    },
    NPM_TIMEOUT,
  );

  it(
    "finds decisions earlier releases stored in the data dir (Linux) and moves them to the config dir",
    async () => {
      const denied = await projectFromAuthor();
      const trusted = await projectFromAuthor();
      // Earlier releases kept trust.json in $XDG_DATA_HOME/frameshell: today's Linux data dir.
      const legacyDir = tempDir();
      const legacy = await daemonFor({ dataDir: tempDir(), configDir: legacyDir });
      await legacy.conn.request("project.trust", { cwd: denied, decision: "deny" });
      await legacy.conn.request("project.trust", { cwd: trusted, decision: "trust" });

      const upgraded = await daemonFor({ dataDir: legacyDir, configDir: tempDir() });
      expect((await upgraded.conn.request("status", { cwd: denied })).trust?.state).toBe("denied");
      expect((await upgraded.conn.request("status", { cwd: trusted })).trust?.state).toBe("trusted");

      // The next decision writes every known decision to the config dir.
      await upgraded.conn.request("project.trust", { cwd: denied, decision: "trust" });
      const restarted = await daemonFor({ dataDir: tempDir(), configDir: upgraded.dirs.configDir });
      expect((await restarted.conn.request("status", { cwd: denied })).trust?.state).toBe("trusted");
      expect((await restarted.conn.request("status", { cwd: trusted })).trust?.state).toBe("trusted");
    },
    NPM_TIMEOUT,
  );

  it(
    "asks again when the declared plugin list changes",
    async () => {
      const dir = await projectFromAuthor();
      const { conn } = await daemonFor();
      await conn.request("project.trust", { cwd: dir, decision: "trust" });

      const configPath = join(dir, "frameshell.json");
      const original = readFileSync(configPath, "utf8");
      const config = JSON.parse(original);
      config.plugins["sneaky-plugin"] = "1.0.0";
      writeFileSync(configPath, JSON.stringify(config));
      expect((await conn.request("status", { cwd: dir })).trust?.state).toBe("unknown");
      await expect(greet(conn, dir)).rejects.toMatchObject({ code: ErrorCode.ProjectNotTrusted });

      writeFileSync(configPath, original);
      expect((await conn.request("status", { cwd: dir })).trust?.state).toBe("trusted");
    },
    NPM_TIMEOUT,
  );

  it(
    "refuses to install into a project whose declared plugins are not trusted",
    async () => {
      const dir = await projectFromAuthor();
      const { conn } = await daemonFor();
      await expect(conn.request("plugin.install", { cwd: dir, spec: hello.spec })).rejects.toMatchObject({
        code: ErrorCode.ProjectNotTrusted,
      });
    },
    NPM_TIMEOUT,
  );
});

describe("plugins directory", () => {
  it(
    "is regenerated from the pins in frameshell.json once the project is trusted",
    async () => {
      const dir = await projectFromAuthor();
      rmSync(join(dir, ".frameshell", "plugins"), { recursive: true, force: true });
      const { conn } = await daemonFor();
      await conn.request("project.trust", { cwd: dir, decision: "trust" });

      expect((await greet(conn, dir)).output).toBe("Hello, Ana!");
      expect(existsSync(join(dir, ".frameshell/plugins/node_modules/hello-plugin"))).toBe(true);
    },
    NPM_TIMEOUT,
  );

  it(
    "loses the plugin and its pin on remove",
    async () => {
      const { conn } = await daemonFor();
      const dir = tempDir();
      await conn.request("project.init", { dir });
      const { pin } = await conn.request("plugin.install", { cwd: dir, spec: hello.spec });

      expect(await conn.request("plugin.remove", { cwd: dir, name: "hello-plugin" })).toEqual({
        dir,
        name: "hello-plugin",
        pin,
      });
      expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8")).plugins).toEqual({});
      expect(existsSync(join(dir, ".frameshell/plugins/node_modules/hello-plugin"))).toBe(false);
      await expect(greet(conn, dir)).rejects.toMatchObject({ code: ErrorCode.CommandNotFound });
      await expect(conn.request("plugin.remove", { cwd: dir, name: "hello-plugin" })).rejects.toMatchObject({
        code: ErrorCode.PluginNotFound,
      });
    },
    NPM_TIMEOUT,
  );
});
