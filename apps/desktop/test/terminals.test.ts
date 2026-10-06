import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalLaunch } from "../src/main/terminal-launch.js";
import { TerminalManager, type TerminalManagerOptions } from "../src/main/terminals.js";

// Real ptys running the user's real login shell: the same path the app takes.
const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.killAll()));
});

function setup(options?: TerminalManagerOptions) {
  const output = new Map<string, string>();
  const exits = new Map<string, number>();
  /** Agent changes per terminal, in order: `[session, agent]`. */
  const agents = new Map<string, [string | null, string | null][]>();
  const manager = new TerminalManager({
    onData: (id, data) => output.set(id, (output.get(id) ?? "") + data),
    onExit: (id, code) => exits.set(id, code),
    onAgent: (id, session, agent) => agents.set(id, [...(agents.get(id) ?? []), [session, agent]]),
  }, options);
  managers.push(manager);
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-term-")));
  const launch = (session: string) =>
    terminalLaunch({
      platform: process.platform,
      env: process.env,
      projectDir,
      socketPath: "/tmp/unused.sock",
      session,
      binDir: projectDir,
    });
  return { manager, output, exits, agents, launch, projectDir };
}

const echoSession =
  process.platform === "win32" ? "echo \"sess=$env:FRAMESHELL_SESSION\"\r" : "echo \"sess=$FRAMESHELL_SESSION\"\r";

describe("TerminalManager", () => {
  it("runs a shell whose environment names its session", async () => {
    const { manager, output, launch } = setup();
    const { id } = manager.create(launch("term-aaaa"), { cols: 80, rows: 24 });
    manager.write(id, echoSession);
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("sess=term-aaaa");
  });

  it("keeps sessions apart", async () => {
    const { manager, output, launch } = setup();
    const a = manager.create(launch("term-one1"), { cols: 80, rows: 24 });
    const b = manager.create(launch("term-two2"), { cols: 80, rows: 24 });
    manager.write(b.id, echoSession);
    await expect.poll(() => output.get(b.id) ?? "", { timeout: 15_000 }).toContain("sess=term-two2");
    expect(output.get(a.id) ?? "").not.toContain("term-two2");
  });

  it("reports the exit of a shell that quits", async () => {
    const { manager, exits, launch } = setup();
    const { id } = manager.create(launch("term-exit"), { cols: 80, rows: 24 });
    manager.write(id, "exit\r");
    await expect.poll(() => exits.has(id), { timeout: 15_000 }).toBe(true);
    expect(manager.has(id)).toBe(false);
  });

  // The app quits once this settles. On Windows a shell killed before its first output is only killed later by
  // node-pty; quitting before that left Electron hung at exit with the pseudoconsole open (#109).
  it("killAll settles once every shell has exited, even one killed right after it started", async () => {
    const { manager, exits, launch } = setup();
    const fresh = manager.create(launch("term-fresh"), { cols: 80, rows: 24 });
    const started = manager.create(launch("term-started"), { cols: 80, rows: 24 });
    manager.write(started.id, echoSession);
    await manager.killAll();
    expect(exits.has(fresh.id)).toBe(true);
    expect(exits.has(started.id)).toBe(true);
  });

  // #120: the agent runs the daemon's ffmpeg by hand. The variable survives login profiles that reorder PATH.
  it.skipIf(process.platform === "win32")("runs the managed tools the launch names", async () => {
    const { manager, output, projectDir } = setup();
    const tool = join(projectDir, "tools", "ffmpeg");
    mkdirSync(join(projectDir, "tools"));
    writeFileSync(tool, "#!/bin/sh\necho fake-ffmpeg-ran\n", { mode: 0o755 });
    const launch = terminalLaunch({
      platform: process.platform,
      env: process.env,
      projectDir,
      socketPath: "/tmp/unused.sock",
      session: "term-tools",
      binDir: projectDir,
      tools: { ffmpeg: tool },
    });
    const { id } = manager.create(launch, { cols: 80, rows: 24 });
    manager.write(id, '"$FRAMESHELL_FFMPEG"\r');
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("fake-ffmpeg-ran");
  });

  it.skipIf(process.platform === "win32")("applies resizes to the pty", async () => {
    const { manager, output, launch } = setup();
    const { id } = manager.create(launch("term-size"), { cols: 80, rows: 24 });
    manager.resize(id, 132, 40);
    manager.write(id, "stty size\r");
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("40 132");
  });

  it.skipIf(process.platform === "win32")("tags a terminal with the agent CLI in its foreground, until it quits", async () => {
    const { manager, output, agents, launch } = setup();
    const { id } = manager.create(launch("term-agent"), { cols: 80, rows: 24 });
    // Node CLIs such as Claude Code set their process title: `ps` shows `claude`.
    manager.write(id, `node -e "process.title='claude'; console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("agent up");
    await expect.poll(() => agents.get(id) ?? [], { timeout: 15_000 }).toEqual([["term-agent", "claude"]]);
    expect(manager.agents()).toEqual([{ session: "term-agent", agent: "claude" }]);
    manager.write(id, "\x03");
    await expect.poll(() => agents.get(id) ?? [], { timeout: 15_000 }).toEqual([
      ["term-agent", "claude"],
      ["term-agent", null],
    ]);
    expect(manager.agents()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("tags an agent that sets its process title after the first look at it", async () => {
    // A look between exec and `process.title = ...` sees plain `node`: that miss must not stick.
    let titleSet = false;
    const { manager, output, agents, launch } = setup({ detectAgent: async () => (titleSet ? "claude" : null), agentPollMs: 50 });
    const { id } = manager.create(launch("term-late"), { cols: 80, rows: 24 });
    manager.write(id, `node -e "console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("agent up");
    // Several polls with `node` in the foreground: the watcher has looked at it, before any title.
    await new Promise((resolve) => setTimeout(resolve, 500));
    titleSet = true;
    await expect.poll(() => agents.get(id) ?? [], { timeout: 5_000 }).toEqual([["term-late", "claude"]]);
  });

  it.skipIf(process.platform === "win32")("untags a terminal closed while its agent runs", async () => {
    const { manager, output, agents, launch } = setup();
    const { id } = manager.create(launch("term-gone"), { cols: 80, rows: 24 });
    manager.write(id, `node -e "process.title='codex'; console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("agent up");
    await expect.poll(() => agents.get(id) ?? [], { timeout: 15_000 }).toEqual([["term-gone", "codex"]]);
    manager.kill(id);
    expect(agents.get(id)).toEqual([
      ["term-gone", "codex"],
      ["term-gone", null],
    ]);
  });
});
