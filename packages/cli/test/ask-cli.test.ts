import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Daemon, startDaemon } from "@frameshell/core";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runAsk } from "../src/index.js";

// Seam under test: `frameshell ask` (ADR 0025 decision 4), in process against a real daemon, and the built binary
// where it matters that no daemon is started. The app's side is a plain connection sending `inbox.put`.

const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
let n = 0;
const socketPathFor = (tag: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-ask-${process.pid}-${tag}-${n++}`
    : join(realpathSync(tmpdir()), `fs-ask-${process.pid}-${n++}.sock`);

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "frameshell-ask-")));
  const dirs = { dataDir: join(root, "data"), configDir: join(root, "config") };
  const socketPath = socketPathFor("d");
  daemon = await startDaemon({ socketPath, dirs });
  const app = await connectToDaemon(socketPath, { client: "desktop/test" });
  connections.push(app);
  const dir = join(root, "talk");
  await app.request("project.init", { dir });
  const env = { FRAMESHELL_SOCKET: socketPath, FRAMESHELL_DATA_DIR: dirs.dataDir, FRAMESHELL_CONFIG_DIR: dirs.configDir, FRAMESHELL_SESSION: "sh-test" };
  const ask = async (argv: string[], extra: NodeJS.ProcessEnv = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await runAsk(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text), cwd: dir, env: { ...env, ...extra } });
    return { code, stdout, stderr };
  };
  return { dir, app, ask };
}

describe("frameshell ask", () => {
  it("--take prints what waits for the agent it runs under, removes it, and prints nothing for others", async () => {
    const { dir, app, ask } = await setup();
    const mcp = await connectToDaemon(daemon!.socketPath, { client: "mcp/test" });
    connections.push(mcp);
    await mcp.request("target.register", { cwd: dir, client: "claude-code", kind: "mcp" });
    await app.request("inbox.put", { cwd: dir, target: "claude", lines: ["[frameshell] clip c_a", "make it shorter"] });
    await app.request("inbox.put", { cwd: dir, target: "claude", lines: ["[frameshell] word w_000002"] });

    expect(await ask(["--take"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await ask(["--take"], { FRAMESHELL_AGENT: "claude" })).toEqual({
      code: 0,
      stdout: "[frameshell] clip c_a\nmake it shorter\n\n[frameshell] word w_000002\n",
      stderr: "",
    });
    expect(await ask(["--take", "--target", "claude"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("--wait shows the terminal as a target and prints the next reference", async () => {
    const { dir, app, ask } = await setup();
    const waiting = ask(["--wait", "--as", "codex", "--timeout", "30"]);
    await expect.poll(async () => (await app.request("target.list", { cwd: dir })).targets.map((target) => target.id)).toEqual(["codex"]);
    await app.request("inbox.put", { cwd: dir, target: "codex", lines: ["[frameshell] range 00:00:01.00–00:00:02.00"] });
    expect(await waiting).toEqual({ code: 0, stdout: "[frameshell] range 00:00:01.00–00:00:02.00\n", stderr: "" });
    await expect.poll(async () => (await app.request("target.list", { cwd: dir })).targets).toEqual([]);
  });

  it("--wait exits 6 when nothing came before the timeout", async () => {
    const { ask } = await setup();
    expect(await ask(["--wait", "--timeout", "0.2"])).toEqual({ code: 6, stdout: "", stderr: "" });
  });

  it("refuses wrong flag combinations", async () => {
    const out = (argv: string[]) => runAsk(argv, { stdout: () => {}, stderr: () => {}, cwd: tmpdir(), env: {} });
    expect(await out([])).toBe(2);
    expect(await out(["--take", "--wait"])).toBe(2);
    expect(await out(["--take", "--timeout", "5"])).toBe(2);
    expect(await out(["--wait", "--target", "claude"])).toBe(2);
    expect(await out(["--wait", "--timeout", "0"])).toBe(2);
  });

  it("--take with no daemon running prints nothing, exits 0 and starts none", () => {
    const socketPath = socketPathFor("none");
    const result = spawnSync(process.execPath, [cliBin, "ask", "--take"], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, FRAMESHELL_SOCKET: socketPath },
    });
    expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    if (process.platform !== "win32") expect(existsSync(socketPath)).toBe(false);
  });
});
