import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// `frameshell review`, black-box: built CLI, auto-started daemon, managed ffmpeg, a 1 s synthetic clip.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-review-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-rev-${randomUUID().slice(0, 8)}.sock`);

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
let daemonPid: number | undefined;

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-review-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-"))), "take.mp4");
  await makeClip(footage, { durationS: 1 });
  expect(frameshell(["import", footage]).code).toBe(0);
  const track = JSON.parse(frameshell(["track", "add", "video", "--json"]).stdout).changes.added[0] as string;
  expect(frameshell(["clip", "add", track, "assets/take.mp4"]).code).toBe(0);
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

describe("frameshell review", () => {
  it(
    "writes the sheets asked for and prints where they are",
    () => {
      const result = frameshell(["review", "--sheets", "contact,seam", "--range", "0.2,0.8"]);
      expect(result.code, result.stderr).toBe(0);
      const dir = join(project, ".frameshell", "review", "1");
      expect(result.stdout).toContain(`Review 1 of timeline main: 0.2 to 0.8 s, 1920x1080 at 30 fps -> ${dir}`);
      expect(result.stdout).toContain(`${join(dir, "contact.png")}  `);
      expect(result.stdout).toContain(`${join(dir, "seam.png")}  `);
      expect(existsSync(join(dir, "contact.png"))).toBe(true);
      expect(existsSync(join(dir, "review.json"))).toBe(true);
    },
    120_000,
  );

  it(
    "reviews a file with --json",
    () => {
      const result = frameshell(["review", "--file", "assets/take.mp4", "--sheets", "phone", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const review = JSON.parse(result.stdout) as { source: string; file: string; run: number; sheets: { kind: string; tiles: unknown[] }[] };
      expect(review).toMatchObject({ source: "file", file: join(project, "assets", "take.mp4"), run: 2 });
      expect(review.sheets).toMatchObject([{ kind: "phone", tiles: [{ at: 0 }] }]);
    },
    120_000,
  );

  it(
    "draws the zones of --platform (an alias works) and prints them",
    () => {
      const result = frameshell(["review", "--platform", "instagram", "--sheets", "safe", "--range", "0,0.5"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("safe-instagram-reels.png");
      // The test project is 16:9: the vertical platform's numbers are scaled per axis, with a warning.
      expect(result.stdout).toContain("Safe zones instagram-reels (measured): top 124, right 249, bottom 214, left 0 px");
      expect(result.stdout).toContain("warning: safe: instagram-reels is a vertical platform and the film is not");
      const json = JSON.parse(frameshell(["review", "--platform", "shorts", "--sheets", "safe", "--range", "0,0.5", "--json"]).stdout) as { safeZones: { platform: string }[] };
      expect(json.safeZones.map((zone) => zone.platform)).toEqual(["youtube-shorts"]);
    },
    120_000,
  );

  it(
    "prints the metrics and the loudness of a file, writes metrics.json, and metrics alone write no sheets",
    () => {
      const result = frameshell(["review", "--file", "assets/take.mp4", "--sheets", "metrics"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Metrics \(\d+ samples, [\d.]+ s apart\): longest still /);
      expect(result.stdout).toMatch(/loudness: -?[\d.]+ LUFS, range [\d.]+ LU, true peak -?[\d.]+ dBTP, phone band -?[\d.]+ LUFS/);
      const run = /Review (\d+) of/.exec(result.stdout)![1]!;
      expect(existsSync(join(project, ".frameshell", "review", run, "metrics.json"))).toBe(true);
      expect(existsSync(join(project, ".frameshell", "review", run, "contact.png"))).toBe(false);
    },
    120_000,
  );

  it(
    "prints the loop seam and, with --preset, the delivery check of a file against its export plan",
    () => {
      const seam = frameshell(["review", "--file", "assets/take.mp4", "--sheets", "metrics", "--loop"]);
      expect(seam.code, seam.stderr).toBe(0);
      expect(seam.stdout).toMatch(/loop seam: the last frame \([\d.]+ s\) differs from the first by [\d.]+ of 255 \((continuous|cut|duplicate)\)/);
      // The clip is 320x240: against the 1080p plan of the project every size check fails.
      const delivery = frameshell(["review", "--file", "assets/take.mp4", "--preset", "youtube-1080p", "--sheets", "metrics"]);
      expect(delivery.code, delivery.stderr).toBe(0);
      expect(delivery.stdout).toContain("delivery against main with youtube-1080p (16x9): differs");
      expect(delivery.stdout).toContain("BAD width: 320 (plan 1920)");
      expect(delivery.stdout).toContain("craft delivery: the file differs from the export plan");
      const json = JSON.parse(frameshell(["review", "--file", "assets/take.mp4", "--preset", "youtube-1080p", "--sheets", "metrics", "--json"]).stdout) as { metrics: { delivery: { checks: { field: string; ok: boolean }[] } } };
      expect(json.metrics.delivery.checks.find((check) => check.field === "width")).toMatchObject({ ok: false });
    },
    120_000,
  );

  it(
    "prints the checks of requirements.json, exits 1 on a failure and not on a waived warning",
    () => {
      const path = join(project, "requirements.json");
      try {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, film: { maxSeconds: 0.5, minSeconds: 0.5 } }));
        const failed = frameshell(["review", "--sheets", "metrics"]);
        expect(failed.code, failed.stderr).toBe(1);
        expect(failed.stdout).toContain("requirements.json: 1 failed, 1 of 2 checks pass");
        expect(failed.stdout).toContain("FAIL film.maxSeconds: the film runs 1 s, over the 0.5 s the project allows.");
        // A craft check that fails when listed, then waived with a reason: reported, not failing.
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, fail: ["frame-0", "static"], waivers: [{ check: "frame-0", reason: "fades in" }, { check: "static", reason: "x" }] }));
        const waived = frameshell(["review", "--sheets", "metrics"]);
        expect(waived.code, waived.stderr).toBe(0);
        expect(waived.stdout).toContain("requirements.json: met, 0 of 0 checks pass");
        expect(waived.stdout).toContain("unused waiver of static: x");
        const json = JSON.parse(frameshell(["review", "--sheets", "metrics", "--json"]).stdout) as { metrics: { waived: unknown[]; requirements: { failed: number } } };
        expect(json.metrics.requirements.failed).toBe(0);
      } finally {
        rmSync(path, { force: true });
      }
    },
    120_000,
  );

  it("rejects --preset without --file", () => {
    expect(frameshell(["review", "--preset", "youtube-1080p"]).stderr).toContain("--preset checks an exported file against its export plan: pass --file too");
  });

  it("rejects a bad range, sheet or flag before talking to the daemon", () => {
    expect(frameshell(["review", "--platform", "myspace"]).stderr).toContain("--platform takes instagram-reels, tiktok, youtube-shorts, youtube");
    expect(frameshell(["review", "--range", "5"]).stderr).toContain("--range takes two seconds");
    expect(frameshell(["review", "--range", "5,2"]).code).toBe(2);
    expect(frameshell(["review", "--sheets", "contact,poster"]).stderr).toContain("unknown: poster");
    expect(frameshell(["review", "--sheets", "contact,poster"]).stderr).toContain("seam, metrics");
    expect(frameshell(["review", "--every", "0"]).stderr).toContain("--every takes seconds above 0");
    expect(frameshell(["review", "--at", "1"]).stderr).toContain("`frameshell review` does not take --at");
    expect(frameshell(["review", "extra"]).code).toBe(2);
  });
});
