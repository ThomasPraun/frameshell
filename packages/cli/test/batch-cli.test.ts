import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "../../core/test/plugin-fixture.js";

// `frameshell batch` black-box (ADR 0040): built CLI, auto-started daemon, managed ffmpeg, rows swapping a 1 s clip's asset.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-batch-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-bat-${randomUUID().slice(0, 8)}.sock`);

const cliEnv = () => ({
  ...process.env,
  FRAMESHELL_SOCKET: socketPath,
  FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
  FRAMESHELL_DATA_DIR: testBinariesDir(),
  FRAMESHELL_CONFIG_DIR: testBinariesDir(),
});

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: "utf8", env: cliEnv() });
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
    "--review prints each row's verdict after its file and exits 1 when requirements.json fails one",
    async () => {
      writeBatch([{ id: "a" }]);
      const out = join(project, "exports", "launch");
      const clean = frameshell(["batch", "launch.batch.json", "--force", "--review"]);
      expect(clean.code, clean.stderr).toBe(0);
      expect(clean.stdout).toContain(`Rendered ${join(out, "a.mp4")}\n  review: `);
      expect(clean.stdout).toMatch(/, run \d+ \(\.frameshell\/review\/\d+\/metrics\.json\)\n/);
      const requirements = join(project, "requirements.json");
      writeFileSync(requirements, JSON.stringify({ schemaVersion: 1, film: { maxSeconds: 0.5 } }));
      try {
        const failing = frameshell(["batch", "launch.batch.json", "--force", "--review", "--json"]);
        expect(failing.code, failing.stderr).toBe(1);
        const entries = (JSON.parse(failing.stdout) as { entries: { status: string; review: { state: string; verdict: string; failed: number } }[] }).entries;
        expect(entries[0]).toMatchObject({ status: "done", review: { state: "done", verdict: "fail" } });
        expect(entries[0]!.review.failed).toBeGreaterThan(0);
      } finally {
        rmSync(requirements);
      }
    },
    180_000,
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

  it(
    "asks for --yes before the finals of the rows add up over 5 minutes, then renders them (ADR 0035)",
    () => {
      const parent = dirname(project);
      const dir = join(parent, "finals");
      expect(frameshell(["init", dir], parent).code).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
      installLocalPlugin(dir, CARD_PLUGIN, "card-plugin");
      mkdirSync(join(dir, "compositions", "cards"), { recursive: true });
      // A final the fixture estimates at 400 s: over the 5 minutes that need the person's word.
      writeFileSync(join(dir, "compositions", "cards", "slow.json"), JSON.stringify({ color: "blue", finalColor: "red", seconds: 1, estimateSeconds: 400 }));
      const track = JSON.parse(frameshell(["track", "add", "video", "--json"], dir).stdout).changes.added[0] as string;
      const added = frameshell(["clip", "add", track, "--type", "final-card", "--source", "compositions/cards/slow.json", "--duration", "1", "--trust", "--json"], dir);
      expect(added.code, added.stderr).toBe(0);
      const card = JSON.parse(added.stdout).changes.added[0] as string;
      writeFileSync(join(dir, "cards.batch.json"), JSON.stringify({ schemaVersion: 1, slots: { label: `${card}.props.label` }, rows: [{ id: "a", label: "A" }] }));
      const out = join(dir, "exports", "cards");

      // A dry run never asks; the real run is refused before anything is queued.
      expect(frameshell(["batch", "cards.batch.json", "--dry-run"], dir).code).toBe(0);
      const refused = frameshell(["batch", "cards.batch.json"], dir);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("This batch renders the final render of 1 generated clip first, estimated at about 6.7 min");
      expect(refused.stderr).toContain("--yes");
      expect(existsSync(join(out, "manifest.json"))).toBe(false);

      const agreed = frameshell(["batch", "cards.batch.json", "--yes"], dir);
      expect(agreed.code, agreed.stderr).toBe(0);
      expect(agreed.stdout).toBe(`Rendered ${join(out, "a.mp4")}\nManifest: ${join(out, "manifest.json")}\n`);
      expect(existsSync(join(out, "a.mp4"))).toBe(true);
    },
    180_000,
  );

  it("batch cancel says so when no batch is rendering", () => {
    writeBatch([{ id: "a" }]);
    const result = frameshell(["batch", "cancel", "launch.batch.json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No batch is rendering into");
  });

  it(
    "batch cancel stops a batch another process is following: the rows after the running one never start, and that process ends with exit 1",
    async () => {
      writeBatch(Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, ...(index % 2 ? { shot: "assets/long.mp4" } : {}) })));
      const out = join(project, "exports", "launch");
      rmSync(out, { recursive: true, force: true });
      const batch = spawn(process.execPath, [cliBin, "batch", "launch.batch.json", "--force"], { cwd: project, env: cliEnv() });
      let stdout = "";
      let stderr = "";
      batch.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      batch.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => batch.on("close", resolve));
      for (let i = 0; i < 300 && !existsSync(join(out, "manifest.json")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const canceled = frameshell(["batch", "cancel", "launch.batch.json"]);
      expect(canceled.code, canceled.stderr).toBe(0);
      expect(canceled.stdout).toMatch(/^Batch .*launch\.batch\.json canceled \(rows not rendered: .*r7.*\)/);
      expect(await exited, stderr).toBe(1);
      expect(stdout).toMatch(/canceled \(rows not rendered: .*r7/);
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { state: string; entries: { row: string; status: string }[] };
      expect(manifest.state).toBe("canceled");
      expect(manifest.entries.find((entry) => entry.row === "r7")!.status).toBe("canceled");
      expect(existsSync(join(out, "r7.mp4"))).toBe(false);
    },
    180_000,
  );
});
