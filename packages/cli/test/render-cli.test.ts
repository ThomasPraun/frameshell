import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Smoke render, black-box: built CLI, auto-started daemon, managed ffmpeg, a 1 s synthetic clip.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-render-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-rnd-${randomUUID().slice(0, 8)}.sock`);

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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-render-")));
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

describe("frameshell render and frame", () => {
  it(
    "renders with the default preset, waiting for the job and reporting progress on stderr",
    () => {
      const result = frameshell(["render", "--out", "out/talk.mp4"]);
      expect(result.code, result.stderr).toBe(0);
      const output = join(project, "out", "talk.mp4");
      expect(result.stdout).toBe(`Rendered ${output}\n`);
      expect(result.stderr).toContain(`Rendering timelines/main.json -> ${output}`);
      expect(result.stderr).toContain("youtube-1080p · 1920x1080 · 30/1 fps · 1 s");
      expect(result.stderr).toMatch(/render timelines\/main\.json: done/);
      expect(existsSync(output)).toBe(true);
    },
    120_000,
  );

  it(
    "renders --json with the finished job",
    () => {
      const result = frameshell(["render", "--preset", "vertical-1080x1920", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as { output: string; job: { state: string } };
      expect(parsed).toMatchObject({ output: join(project, "exports", "main-vertical-1080x1920.mp4"), job: { state: "done" } });
    },
    120_000,
  );

  it("writes a frame as PNG", () => {
    const result = frameshell(["frame", "--at", "0.5", "--out", "shot.png"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Wrote .*shot\.png \(frame 15 at 0\.5 s, c_[0-9a-f]{6}, 1920x1080\)\n$/);
    expect(readFileSync(join(project, "shot.png")).subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("explains missing frame flags and unknown presets", () => {
    const noAt = frameshell(["frame", "--out", "x.png"]);
    expect(noAt.code).toBe(2);
    expect(noAt.stderr).toContain("--at <seconds>");
    const bad = frameshell(["render", "--preset", "dvd"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/No export preset "dvd"\. Available: youtube-1080p, youtube-1440p, vertical-1080x1920/);
  });
});
