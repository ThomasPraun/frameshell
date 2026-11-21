import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalLaunch } from "../src/main/terminal-launch.js";
import { TerminalManager, type TerminalManagerOptions, processExists } from "../src/main/terminals.js";

// Real ptys running the user's real login shell: the same path the app takes.
// vitest.config.ts turns every known agent off for the CLI's parent-process walk; detection here needs them on.
vi.stubEnv("FRAMESHELL_AGENT_COMMANDS", "");
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

// A Windows shell can take tens of seconds to print its first prompt on a loaded runner; input written
// before that is lost to the profile scripts.
const POLL_MS = process.platform === "win32" ? 60_000 : 15_000;

/**
 * Waits until the terminal's shell has printed its prompt, so what is written next is read by the shell.
 * Off Windows a themed prompt that the pattern misses only costs the wait, not the test.
 */
async function waitForPrompt(output: Map<string, string>, id: string): Promise<void> {
  const windows = process.platform === "win32";
  const prompt = windows ? /PS .*>/ : /[$%#] /;
  const seen = expect.poll(() => prompt.test(output.get(id) ?? ""), { timeout: windows ? POLL_MS : 5_000, message: "the shell printed no prompt" }).toBe(true);
  await (windows ? seen : seen.catch(() => undefined));
}

const echoSession =
  process.platform === "win32" ? "echo \"sess=$env:FRAMESHELL_SESSION\"\r" : "echo \"sess=$FRAMESHELL_SESSION\"\r";

describe("TerminalManager", () => {
  it("runs a shell whose environment names its session", async () => {
    const { manager, output, launch } = setup();
    const { id } = manager.create(launch("term-aaaa"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, echoSession);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("sess=term-aaaa");
  });

  it("keeps sessions apart", async () => {
    const { manager, output, launch } = setup();
    const a = manager.create(launch("term-one1"), { cols: 80, rows: 24 });
    const b = manager.create(launch("term-two2"), { cols: 80, rows: 24 });
    await waitForPrompt(output, b.id);
    manager.write(b.id, echoSession);
    await expect.poll(() => output.get(b.id) ?? "", { timeout: POLL_MS }).toContain("sess=term-two2");
    expect(output.get(a.id) ?? "").not.toContain("term-two2");
  });

  it("reports the exit of a shell that quits", async () => {
    const { manager, output, exits, launch } = setup();
    const { id } = manager.create(launch("term-exit"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, "exit\r");
    await expect.poll(() => exits.has(id), { timeout: POLL_MS }).toBe(true);
    expect(manager.has(id)).toBe(false);
  });

  // ADR 0012: a view that mounts again (a tab moved to another window) replays the terminal's output.
  it("replays a terminal's output to a view that attaches, and keeps it until the terminal is killed", async () => {
    const { manager, output, exits, launch } = setup();
    const { id } = manager.create(launch("term-replay"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, echoSession);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("sess=term-replay");
    // Everything sent before attach returns is in the replay: the same text, byte for byte.
    expect(manager.attach(id)).toBe(output.get(id));
    manager.write(id, "exit\r");
    await expect.poll(() => exits.has(id), { timeout: POLL_MS }).toBe(true);
    expect(manager.attach(id)).toContain("sess=term-replay");
    manager.kill(id);
    expect(manager.attach(id)).toBeNull();
    expect(manager.attach("never-created")).toBeNull();
  });

  it("caps the output it keeps", async () => {
    const { manager, output, launch } = setup({ outputLimits: { lines: 20, size: 100_000 } });
    const { id } = manager.create(launch("term-cap"), { cols: 80, rows: 24 });
    const count = process.platform === "win32" ? "1..200 | % { \"n=$_\" }\r" : "for i in $(seq 1 200); do echo n=$i; done\r";
    await waitForPrompt(output, id);
    manager.write(id, count);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("n=200");
    const replay = manager.attach(id)!;
    expect(replay).toContain("n=200");
    expect(replay).not.toContain("n=100\r");
    expect(replay.split("\n").length).toBeLessThanOrEqual(26);
  });

  // The app quits once this settles. On Windows a shell killed before its first output is only killed later by
  // node-pty; quitting before that left Electron hung at exit with the pseudoconsole open.
  it("killAll settles once every shell has exited, even one killed right after it started", async () => {
    const { manager, output, exits, launch } = setup();
    const started = manager.create(launch("term-started"), { cols: 80, rows: 24 });
    await waitForPrompt(output, started.id);
    manager.write(started.id, echoSession);
    // Created after the wait so this shell is still killed right after it starts.
    const fresh = manager.create(launch("term-fresh"), { cols: 80, rows: 24 });
    await manager.killAll();
    expect(exits.has(fresh.id)).toBe(true);
    expect(exits.has(started.id)).toBe(true);
  });

  // The agent runs the daemon's ffmpeg by hand. The variable survives login profiles that reorder PATH.
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
      tools: { ffmpeg: { path: tool, managed: true } },
    });
    const { id } = manager.create(launch, { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, '"$FRAMESHELL_FFMPEG"\r');
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("fake-ffmpeg-ran");
  });

  it.skipIf(process.platform === "win32")("applies resizes to the pty", async () => {
    const { manager, output, launch } = setup();
    const { id } = manager.create(launch("term-size"), { cols: 80, rows: 24 });
    manager.resize(id, 132, 40);
    await waitForPrompt(output, id);
    manager.write(id, "stty size\r");
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("40 132");
  });

  it.skipIf(process.platform === "win32")("tags a terminal with the agent CLI in its foreground, until it quits", async () => {
    const { manager, output, agents, launch } = setup();
    const { id } = manager.create(launch("term-agent"), { cols: 80, rows: 24 });
    // Node CLIs such as Claude Code set their process title: `ps` shows `claude`.
    await waitForPrompt(output, id);
    manager.write(id, `node -e "process.title='claude'; console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("agent up");
    await expect.poll(() => agents.get(id) ?? [], { timeout: POLL_MS }).toEqual([["term-agent", "claude"]]);
    expect(manager.agents()).toEqual([{ session: "term-agent", agent: "claude" }]);
    manager.write(id, "\x03");
    await expect.poll(() => agents.get(id) ?? [], { timeout: POLL_MS }).toEqual([
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
    await waitForPrompt(output, id);
    manager.write(id, `node -e "console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("agent up");
    // Several polls with `node` in the foreground: the watcher has looked at it, before any title.
    await new Promise((resolve) => setTimeout(resolve, 500));
    titleSet = true;
    await expect.poll(() => agents.get(id) ?? [], { timeout: 5_000 }).toEqual([["term-late", "claude"]]);
  });

  it("with probeEveryPoll (Windows) looks on every poll, the shell's name in the foreground or not", async () => {
    // node-pty's foreground name is the shell's for good on Windows: the agent is read from the process table.
    let running = false;
    const { manager, output, agents, launch } = setup({ detectAgent: async () => (running ? "claude" : null), agentPollMs: 50, probeEveryPoll: true });
    const { id } = manager.create(launch("term-table"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    running = true;
    await expect.poll(() => agents.get(id) ?? [], { timeout: 5_000 }).toEqual([["term-table", "claude"]]);
    running = false;
    await expect.poll(() => agents.get(id) ?? [], { timeout: 5_000 }).toEqual([
      ["term-table", "claude"],
      ["term-table", null],
    ]);
  });

  it.skipIf(process.platform === "win32")("untags a terminal closed while its agent runs", async () => {
    const { manager, output, agents, launch } = setup();
    const { id } = manager.create(launch("term-gone"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, `node -e "process.title='codex'; console.log('agent up'); setTimeout(() => {}, 60000)"\r`);
    await expect.poll(() => output.get(id) ?? "", { timeout: POLL_MS }).toContain("agent up");
    await expect.poll(() => agents.get(id) ?? [], { timeout: POLL_MS }).toEqual([["term-gone", "codex"]]);
    manager.kill(id);
    expect(agents.get(id)).toEqual([
      ["term-gone", "codex"],
      ["term-gone", null],
    ]);
  });
});

describe("killing a shell that already exited", () => {
  it("knows a running process from a finished one", async () => {
    expect(processExists(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(processExists(child.pid!)).toBe(false);
  });

  it("settles when kill is sent while the shell is exiting", async () => {
    const { manager, output, exits, launch } = setup();
    const { id } = manager.create(launch("term-exited"), { cols: 80, rows: 24 });
    await waitForPrompt(output, id);
    manager.write(id, "exit\r");
    manager.kill(id);
    await manager.killAll();
    await expect.poll(() => exits.has(id), { timeout: POLL_MS }).toBe(true);
  });
});
