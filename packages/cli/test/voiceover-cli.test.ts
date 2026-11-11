import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and a daemon it auto-starts with FRAMESHELL_SPEECH_STAND_IN=1 (the built-in stand-in voice).
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-voiceover-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-vo-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: userDirs,
      FRAMESHELL_CONFIG_DIR: userDirs,
      FRAMESHELL_SPEECH_STAND_IN: "1",
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-voiceover-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, "scripts", "vo.md"), ["---", "voiceover: true", "language: en", "---", "## Hook", "Stop scrolling.", "## Why", "Because 3 reasons."].join("\n"));
  const status = JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } };
  daemonPid = status.daemon.pid;
});

afterAll(async () => {
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe("frameshell voiceover generate", () => {
  it("says the chosen lines with the stand-in voice and prints one row per line", () => {
    const result = frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--lines", "hook-1, why-1"]);
    expect(result.stderr).toMatch(/^Saying hook-1 \(1\/2\)/);
    expect(result.code).toBe(0);
    const [head, ...rows] = result.stdout.trimEnd().split("\n");
    expect(head).toBe("Voiceover scripts/vo.md -> assets/voiceover/vo/ (stand-in, voice tone): 2 generated");
    expect(rows).toEqual([expect.stringMatching(/^ {2}hook-1 {2}generated {2}\d\.\d\d s {2}"Stop scrolling\."$/), expect.stringMatching(/^ {2}why-1 {2}generated .*"Because 3 reasons\."$/)]);
    expect(existsSync(join(project, "assets", "voiceover", "vo", "why-1.wav"))).toBe(true);
  });

  it("reports cached lines as JSON and rejects an empty --lines", () => {
    const result = frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { lines: { id: string; state: string; spoken: string }[] };
    expect(parsed.lines.map((line) => [line.id, line.state])).toEqual([
      ["hook-1", "cached"],
      ["why-1", "cached"],
    ]);
    expect(parsed.lines[1]!.spoken).toBe("Because three reasons.");
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--lines", ","]).code).toBe(2);
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--speakers", "2"]).code).toBe(2);
  });
});
