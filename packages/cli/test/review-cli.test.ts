import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
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

  it("rejects a bad range, sheet or flag before talking to the daemon", () => {
    expect(frameshell(["review", "--range", "5"]).stderr).toContain("--range takes two seconds");
    expect(frameshell(["review", "--range", "5,2"]).code).toBe(2);
    expect(frameshell(["review", "--sheets", "contact,poster"]).stderr).toContain("unknown: poster");
    expect(frameshell(["review", "--every", "0"]).stderr).toContain("--every takes seconds above 0");
    expect(frameshell(["review", "--at", "1"]).stderr).toContain("`frameshell review` does not take --at");
    expect(frameshell(["review", "extra"]).code).toBe(2);
  });
});
