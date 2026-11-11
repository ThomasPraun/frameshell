import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Black-box: built CLI, auto-started daemon. `import` records provenance, `credits` judges it and exits 1 on a gap.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-credits-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-crd-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 100_000,
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
let footage: string;
let daemonPid: number | undefined;

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-credits-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  await makeClip(join(footage, "rain.mp4"), { durationS: 0.5 });
  await makeClip(join(footage, "camera.mp4"), { durationS: 0.5 });
  const track = JSON.parse(frameshell(["track", "add", "video", "--json"]).stdout).changes.added[0] as string;
  expect(
    frameshell(["import", join(footage, "rain.mp4"), "--source-url", "https://openverse.org/audio/9f2c", "--licence", "CC-BY-4.0", "--title", "Rain"]).code,
  ).toBe(0);
  expect(frameshell(["import", join(footage, "camera.mp4")]).code).toBe(0);
  expect(frameshell(["clip", "add", track, "assets/rain.mp4", "--start", "0"]).code).toBe(0);
  expect(frameshell(["clip", "add", track, "assets/camera.mp4", "--start", "0.5"]).code).toBe(0);
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

describe("frameshell credits", () => {
  it("fails with exit 1 and says what to do for each asset that cannot be cleared", () => {
    const result = frameshell(["credits"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("NO-CREDIT  assets/rain.mp4  (main)");
    expect(result.stdout).toContain("UNRECORDED  assets/camera.mp4  (main)");
    expect(result.stdout).toContain("frameshell credits set assets/camera.mp4 --licence <id>");
    expect(result.stdout).toContain("2 of 2 placed assets cannot be cleared");
    expect(JSON.parse(frameshell(["credits", "--json"]).stdout)).toMatchObject({ ok: false });
  });

  it("passes once the author is named and the person's own footage is marked own, and prints the credit text", () => {
    const set = frameshell(["credits", "set", "assets/rain.mp4", "--author", "Ana Pérez"]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toBe("assets/rain.mp4  recorded: licence CC-BY-4.0 · by Ana Pérez · https://openverse.org/audio/9f2c\n");
    expect(frameshell(["credits", "set", "camera.mp4", "--licence", "own"], join(project, "assets")).code).toBe(0);

    const result = frameshell(["credits"]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('"Rain" by Ana Pérez, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), https://openverse.org/audio/9f2c');
    expect(result.stdout).toContain("No credit needed: assets/camera.mp4 (own)");
    const ledger = JSON.parse(readFileSync(join(project, "credits.json"), "utf8")) as { assets: { asset: string }[] };
    expect(ledger.assets.map((entry) => entry.asset)).toEqual(["assets/camera.mp4", "assets/rain.mp4"]);
  });

  it("rejects wrong shapes and flags that belong elsewhere with exit 2", () => {
    expect(frameshell(["credits", "set"]).code).toBe(2);
    expect(frameshell(["credits", "--licence", "CC0-1.0"]).stderr).toContain("does not take --licence");
    expect(frameshell(["gc", "--author", "x"]).stderr).toContain("does not take --author");
    expect(frameshell(["clip", "remove", "c_x", "--licence", "CC0-1.0"]).code).toBe(2);
  });
});
