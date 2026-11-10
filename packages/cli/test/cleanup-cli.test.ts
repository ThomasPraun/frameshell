import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CleanupResult } from "@frameshell/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBurstClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Black-box: built CLI, auto-started daemon, a synthetic recording (tone bursts = words) with a hand-written transcript:
// hola 0-0.4 | so the key 1.0-2.0 | so the key idea 3.0-4.5 | okay 6.0-6.5.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-cleanup-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-cl-${randomUUID().slice(0, 8)}.sock`);
const WORDS: [string, number, number][] = [
  ["hola", 0, 0.4],
  ["so", 1.0, 1.3],
  ["the", 1.3, 1.6],
  ["key", 1.6, 2.0],
  ["so", 3.0, 3.3],
  ["the", 3.3, 3.6],
  ["key", 3.6, 4.0],
  ["idea", 4.0, 4.5],
  ["okay", 6.0, 6.5],
];

let project: string;
let daemonPid: number | undefined;

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: testBinariesDir(),
      FRAMESHELL_CONFIG_DIR: testBinariesDir(),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json<T = Record<string, unknown>>(args: string[]): T {
  const result = frameshell([...args, "--json"]);
  if (result.code !== 0) throw new Error(`frameshell ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

const duration = () => json<{ duration: number }>(["timeline", "show"]).duration;

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-cleanup-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-burst-"))), "talk.mp4");
  return makeBurstClip(footage, { durationS: 8, bursts: WORDS.map(([, start, end], index) => [start, end - start, 300 + 40 * index] as const) }).then(() => {
    expect(frameshell(["import", footage, "--wait"]).code).toBe(0);
    daemonPid = json<{ daemon: { pid: number } }>(["status"]).daemon.pid;
    mkdirSync(join(project, "transcripts"), { recursive: true });
    writeFileSync(
      join(project, "transcripts", "talk.words.json"),
      JSON.stringify({
        schemaVersion: 1,
        asset: "assets/talk.mp4",
        assetHash: `sha256:${createHash("sha256").update(readFileSync(join(project, "assets", "talk.mp4"))).digest("hex")}`,
        provider: "test",
        model: "test",
        words: WORDS.map(([text, start, end], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end })),
      }),
    );
    const track = json<{ changes: { added: string[] } }>(["track", "add", "video"]).changes.added[0]!;
    expect(frameshell(["clip", "add", track, "assets/talk.mp4", "--start", "0"]).code).toBe(0);
  });
}, 180_000);

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

describe("frameshell cleanup", () => {
  it("--dry-run prints a table and changes nothing; --json carries the candidates", () => {
    const before = duration();
    const table = frameshell(["cleanup", "--retakes", "--dry-run"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/r1\s+retake/);
    expect(table.stdout).toContain("“so the key”");
    expect(table.stdout).toMatch(/p1\s+pause/);
    expect(table.stdout).toContain("Dry run: nothing changed");
    const result = json<CleanupResult>(["cleanup", "--retakes", "--dry-run"]);
    expect(result.candidates.map((c) => c.id)).toEqual(["r1", "p1"]);
    expect(duration()).toBe(before);
  });

  it("takes --pauses, --breath and --skip", () => {
    const wide = json<CleanupResult>(["cleanup", "--pauses", "1.2", "--dry-run"]);
    expect(wide.candidates).toHaveLength(1);
    const breath = json<CleanupResult>(["cleanup", "--pauses", "1.2", "--breath", "0.3", "--dry-run"]);
    expect(breath.candidates[0]!.duration).toBeLessThan(wide.candidates[0]!.duration);
    const rest = json<CleanupResult>(["cleanup", "--retakes", "--skip", "r1", "--dry-run"]);
    // Rejecting the retake gives back the pauses it covered: the same three a run without --retakes finds.
    expect(rest.candidates.map((c) => c.kind)).toEqual(["pause", "pause", "pause"]);
    expect(rest.candidates.map((c) => c.id)).toEqual(["p2", "p3", "p1"]);
    const retakes = json<CleanupResult>(["cleanup", "--no-pauses", "--retakes", "--dry-run"]);
    expect(retakes.candidates.map((c) => c.kind)).toEqual(["retake"]);
  });

  it("refuses flags that do not go together", () => {
    for (const args of [["--no-pauses"], ["--no-pauses", "--pauses", "0.5", "--retakes"], ["--pauses", "fast"], ["--breath", "0.3"], ["extra"]]) {
      const result = frameshell(["cleanup", ...args]);
      expect(result.code, args.join(" ")).not.toBe(0);
    }
    expect(frameshell(["cut", "--from", "1", "--to", "2", "--dry-run"]).code).toBe(2);
    expect(frameshell(["gc", "--retakes"]).code).toBe(2);
  });

  it("applies one transaction that `revert` undoes", () => {
    const before = duration();
    const result = json<CleanupResult>(["cleanup", "--retakes"]);
    expect(result).toMatchObject({ applied: true, tx: expect.any(String) });
    expect(duration()).toBeCloseTo(before - result.removed, 2);
    const text = frameshell(["history"]).stdout;
    expect(text).toContain("Cleanup: 1 pause, 1 retake");
    expect(frameshell(["revert", result.tx!]).code).toBe(0);
    expect(duration()).toBeCloseTo(before, 2);
    const plain = frameshell(["cleanup", "--retakes"]);
    expect(plain.stdout).toMatch(/Cut [\d.]+ s · revision \d+ · tx /);
  });
});
