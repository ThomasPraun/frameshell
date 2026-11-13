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
    expect(rows).toEqual([
      expect.stringMatching(/^ {2}hook-1 {2}generated {2}\d\.\d\d s {2}2 phrases {2}"Stop scrolling\."$/),
      expect.stringMatching(/^ {2}why-1 {2}generated .*"Because 3 reasons\."$/),
      // No transcription plugin in this project: the check says so, and how to get one.
      expect.stringMatching(/^Verification skipped: No transcription provider "whisper-cpp" .*frameshell plugin install @frameshell\/whisper-cpp/),
    ]);
    expect(existsSync(join(project, "assets", "voiceover", "vo", "why-1.wav"))).toBe(true);
  });

  it("reports cached lines as JSON and rejects an empty --lines", () => {
    const result = frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { lines: { id: string; state: string; spoken: string }[]; [key: string]: unknown };
    expect(parsed.lines.map((line) => [line.id, line.state])).toEqual([
      ["hook-1", "cached"],
      ["why-1", "cached"],
    ]);
    expect(parsed.lines[1]!.spoken).toBe("Because three reasons.");
    expect(parsed.lines[0]).toMatchObject({ check: null, phrases: [{ from: 0, to: expect.any(Number), heard: null }, expect.anything()] });
    expect(parsed).toMatchObject({ phraseFade: 0.012, verification: { status: "skipped", provider: "whisper-cpp" } });
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--lines", ","]).code).toBe(2);
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--speakers", "2"]).code).toBe(2);
  });

  it("skips the misread check with --no-verify", () => {
    const result = frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--no-verify"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Verification was not asked for (`verify: false`).");
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--no-verify", "--json"]).stdout).toContain('"reason": "Verification was not asked for');
  });

  it("takes --voice with a voice id, while clip set --voice stays a switch", () => {
    const result = frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--voice", "tone", "--lines", "hook-1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(stand-in, voice tone)");
    expect(frameshell(["voiceover", "generate", "scripts/vo.md", "--provider", "stand-in", "--voice", "nobody"]).code).not.toBe(0);
  });
});

describe("frameshell voiceover place", () => {
  it("plans a dry run, then puts the phrases on a Voiceover track and prints one row per line", () => {
    const dry = frameshell(["voiceover", "place", "scripts/vo.md", "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    const planned = JSON.parse(dry.stdout) as { dryRun: boolean; tx: unknown; placed: { clip: unknown }[] };
    expect(planned).toMatchObject({ dryRun: true, tx: null });
    expect(planned.placed.length).toBeGreaterThanOrEqual(2);
    expect(planned.placed.every((clip) => clip.clip === null)).toBe(true);

    const result = frameshell(["voiceover", "place", "scripts/vo.md", "--at", "why-1=8", "--gap", "0.5"]);
    expect(result.code).toBe(0);
    const rows = result.stdout.trimEnd().split("\n");
    expect(rows[0]).toMatch(/^Placed \d+ phrases of 2 lines of scripts\/vo\.md on t_\w+ \(Voiceover\), new$/);
    expect(rows).toContainEqual(expect.stringMatching(/^hook-1 {2}0\.000 to \d+\.\d{3} s {2}start$/));
    expect(rows).toContainEqual(expect.stringMatching(/^why-1 {2}8\.000 to \d+\.\d{3} s {2}at$/));
    expect(rows.at(-1)).toMatch(/^ {2}transaction tx_/);
  });

  it("fails on clips already placed unless --replace, and a beat needs a tempo", () => {
    const again = frameshell(["voiceover", "place", "scripts/vo.md"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("clips already play these takes");
    expect(frameshell(["voiceover", "place", "scripts/vo.md", "--replace", "--lines", "hook-1"]).code).toBe(0);
    const beat = frameshell(["voiceover", "place", "scripts/vo.md", "--replace", "--at", "hook-1=beat:3"]);
    expect(beat.code).toBe(1);
    expect(beat.stderr).toContain("the timeline has no tempo");
  });

  it("rejects a malformed --at, --gap, or a flag it does not take", () => {
    expect(frameshell(["voiceover", "place", "scripts/vo.md", "--at", "hook-1"]).stderr).toContain("--at: expected line=time entries");
    expect(frameshell(["voiceover", "place", "scripts/vo.md", "--at", "hook-1=1,hook-1=2"]).stderr).toContain("--at: hook-1 is given twice");
    expect(frameshell(["voiceover", "place", "scripts/vo.md", "--gap", "-1"]).code).toBe(2);
    expect(frameshell(["voiceover", "place", "scripts/vo.md", "--yes"]).code).toBe(2);
    expect(frameshell(["voiceover", "place"]).code).toBe(2);
  });
});
