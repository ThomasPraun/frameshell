import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// `frameshell batch` black-box (ADR 0040): built CLI, auto-started daemon, managed ffmpeg, rows swapping a 1 s clip's asset.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-batch-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-bat-${randomUUID().slice(0, 8)}.sock`);

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

let project: string;
let clip = "";
let daemonPid: number | undefined;

function writeBatch(rows: Record<string, unknown>[]): void {
  writeFileSync(join(project, "launch.batch.json"), JSON.stringify({ schemaVersion: 1, quality: "draft", slots: { shot: `${clip}.asset` }, rows }));
}

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-batch-")));
  project = join(parent, "promo");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  await makeClip(join(footage, "take.mp4"), { width: 160, height: 90, durationS: 1 });
  await makeClip(join(footage, "long.mp4"), { width: 160, height: 90, durationS: 2 });
  await makeClip(join(footage, "short.mp4"), { width: 160, height: 90, durationS: 0.5 });
  expect(frameshell(["import", join(footage, "take.mp4"), join(footage, "long.mp4"), join(footage, "short.mp4")]).code).toBe(0);
  const track = JSON.parse(frameshell(["track", "add", "video", "--json"]).stdout).changes.added[0] as string;
  clip = JSON.parse(frameshell(["clip", "add", track, "assets/take.mp4", "--json"]).stdout).changes.added[0] as string;
  daemonPid = (JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } }).daemon.pid;
}, 120_000);

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

describe("frameshell batch", () => {
  it("checks every row with --dry-run and renders nothing", () => {
    writeBatch([{ id: "a" }, { id: "b", shot: "assets/long.mp4" }]);
    const result = frameshell(["batch", "launch.batch.json", "--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    const out = join(project, "exports", "launch");
    expect(result.stdout).toContain("checks out: 2 row(s) of timelines/main.json, nothing rendered");
    expect(result.stdout).toContain(`  b [16x9] -> ${join(out, "b.mp4")}`);
    expect(existsSync(out)).toBe(false);
  });

  it("names the bad row and slot and exits 1", () => {
    writeBatch([{ id: "a" }, { id: "c", shot: "assets/short.mp4" }]);
    const result = frameshell(["batch", "launch.batch.json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Row c, slot shot: assets/short.mp4 lasts 0.5");
  });

  it(
    "renders the rows one at a time, printing each row's job, then the files and the manifest",
    async () => {
      writeBatch([{ id: "a" }, { id: "b", shot: "assets/long.mp4" }]);
      const result = frameshell(["batch", "launch.batch.json"]);
      expect(result.code, result.stderr).toBe(0);
      const out = join(project, "exports", "launch");
      expect(result.stdout).toBe(`Rendered ${join(out, "a.mp4")}\nRendered ${join(out, "b.mp4")}\nManifest: ${join(out, "manifest.json")}\n`);
      expect(result.stderr).toMatch(/b \[16x9\]: render timelines\/main\.json: done/);
      // The daemon writes the last manifest right after the jobs' final events reach the CLI.
      const read = () => JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { state: string; entries: { status: string }[] };
      for (let i = 0; i < 50 && read().state !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const manifest = read();
      expect(manifest.state).toBe("done");
      expect(manifest.entries.map((entry) => entry.status)).toEqual(["done", "done"]);
    },
    120_000,
  );

  it(
    "re-renders the row whose file is gone, skips the rest, and takes --rows, --failed and --force",
    async () => {
      writeBatch([{ id: "a" }, { id: "b", shot: "assets/long.mp4" }]);
      const out = join(project, "exports", "launch");
      expect(frameshell(["batch", "launch.batch.json", "--force"]).code).toBe(0);
      rmSync(join(out, "b.mp4"));
      const result = frameshell(["batch", "launch.batch.json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`Rendered ${join(out, "b.mp4")}\nManifest: ${join(out, "manifest.json")}\n`);
      expect(result.stderr).toContain("skipped (done, files in place; --force renders them again): a");
      expect(existsSync(join(out, "b.mp4"))).toBe(true);

      const nothing = frameshell(["batch", "launch.batch.json", "--failed"]);
      expect(nothing.code, nothing.stderr).toBe(0);
      expect(nothing.stderr).toContain("nothing to render");
      expect(nothing.stdout).toBe(`Manifest: ${join(out, "manifest.json")}\n`);

      const forced = frameshell(["batch", "launch.batch.json", "--rows", "a..a", "--force", "--dry-run"]);
      expect(forced.stdout).toContain(`  a [16x9] -> ${join(out, "a.mp4")}`);
      expect(forced.stdout).not.toContain("b.mp4");
      const unknown = frameshell(["batch", "launch.batch.json", "--rows", "zz"]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("Row zz");
    },
    180_000,
  );
});
