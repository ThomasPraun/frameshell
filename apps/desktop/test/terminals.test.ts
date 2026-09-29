import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalLaunch } from "../src/main/terminal-launch.js";
import { TerminalManager } from "../src/main/terminals.js";

// Real ptys running the user's real login shell: the same path the app takes.
const managers: TerminalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll();
});

function setup() {
  const output = new Map<string, string>();
  const exits = new Map<string, number>();
  const manager = new TerminalManager({
    onData: (id, data) => output.set(id, (output.get(id) ?? "") + data),
    onExit: (id, code) => exits.set(id, code),
  });
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
  return { manager, output, exits, launch, projectDir };
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

  it.skipIf(process.platform === "win32")("applies resizes to the pty", async () => {
    const { manager, output, launch } = setup();
    const { id } = manager.create(launch("term-size"), { cols: 80, rows: 24 });
    manager.resize(id, 132, 40);
    manager.write(id, "stty size\r");
    await expect.poll(() => output.get(id) ?? "", { timeout: 15_000 }).toContain("40 132");
  });
});
