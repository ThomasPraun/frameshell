import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Black-box: built CLI, auto-started daemon using the shared managed ffmpeg.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-import-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-imp-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd: string) {
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

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-import-")));
let daemonPid: number | undefined;

afterAll(async () => {
  // The spawned daemon exits by idle timeout; wait so no process outlives the run.
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe("frameshell import", () => {
  it(
    "copies a relative path into assets/, --wait blocks until the proxy exists, re-import is cached",
    async () => {
      const project = join(tempDir(), "talk");
      expect(frameshell(["init", project], tempDir()).code).toBe(0);
      const footage = tempDir();
      await makeClip(join(footage, "take 1.mp4"), { durationS: 0.5 });

      const first = frameshell(["import", "take 1.mp4", "--wait", "--json"], footage);
      // cwd is outside the project: the CLI must fail clearly, not import somewhere else.
      expect(first.code).toBe(1);
      expect(first.stderr).toMatch(/frameshell init/);

      const imported = frameshell(["import", join(footage, "take 1.mp4"), "--wait"], project);
      // Followed through `job.progress` events: every step shows, however short (polling skipped some).
      const steps = [...imported.stderr.matchAll(/ingest assets\/take 1\.mp4: (\w+) \d+%/g)].map((match) => match[1]);
      expect(steps.filter((step, i) => step !== steps[i - 1])).toEqual([
        "starting",
        "hash",
        "probe",
        "proxy",
        "sidecar",
        "waveform",
        "thumbnails",
      ]);
      expect(imported.code).toBe(0);
      expect(imported.stdout).toContain("assets/take 1.mp4  imported from");
      expect(imported.stdout).toMatch(/done \(j_\d+\)/);

      const json = JSON.parse(frameshell(["status", "--json"], project).stdout);
      daemonPid = json.daemon.pid;
      expect(json.jobs).toEqual([expect.objectContaining({ asset: "assets/take 1.mp4", state: "done" })]);

      const again = frameshell(["import", join(project, "assets", "take 1.mp4"), "--wait", "--json"], project);
      expect(again.code).toBe(0);
      const result = JSON.parse(again.stdout);
      expect(result.imported[0]).toMatchObject({ asset: "assets/take 1.mp4", copied: false, job: { state: "done", cached: true } });
      expect(existsSync(join(project, ".frameshell", "proxies"))).toBe(true);
    },
    120_000,
  );

  it("exits 2 with usage when no file is given", () => {
    const result = frameshell(["import"], tempDir());
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/import <file…>/);
  });
});
