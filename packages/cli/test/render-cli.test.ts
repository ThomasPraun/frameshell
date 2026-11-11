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
      expect(result.stderr).toContain("youtube-1080p · libx264 · 1920x1080 · 30/1 fps · 1 s");
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

  it(
    "renders a draft with the machine's encoder and names it, and refuses an unknown quality",
    () => {
      const result = frameshell(["render", "--quality", "draft", "--out", "out/draft.mp4"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/youtube-1080p \(draft\) · (libx264|h264_videotoolbox|h264_nvenc) · 1920x1080 · 30\/1 fps/);
      expect(existsSync(join(project, "out", "draft.mp4"))).toBe(true);
      const bad = frameshell(["render", "--quality", "80"]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toMatch(/--quality: expected draft or final, got "80"/);
    },
    120_000,
  );

  it("writes a frame as PNG", () => {
    const result = frameshell(["frame", "--at", "0.5", "--out", "shot.png"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Wrote .*shot\.png \(frame 15 at 0\.5 s, c_[0-9a-f]{6}, 1920x1080\)\n$/);
    expect(readFileSync(join(project, "shot.png")).subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("writes a frame as JPEG with --format and --quality, and refuses unknown values", () => {
    const result = frameshell(["frame", "--at", "0.5", "--out", "shot.img", "--format", "jpg", "--quality", "40"]);
    expect(result.code, result.stderr).toBe(0);
    expect([...readFileSync(join(project, "shot.img")).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(frameshell(["frame", "--at", "0", "--out", "x.gif", "--format", "gif"]).stderr).toMatch(/--format: expected png, jpg or webp/);
    expect(frameshell(["frame", "--at", "0", "--out", "x.jpg", "--quality", "0"]).stderr).toMatch(/--quality: expected an integer from 1 to 100/);
  });

  it("writes a cover with a word over a frame, and says whether it reads at thumbnail size", () => {
    const result = frameshell(["cover", "--text", "hook", "--at", "0.5", "--out", "cover.png"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Wrote .*cover\.png \(frame 15 at 0\.5 s, 1920x1080, "HOOK"\)\nReadable at 180 px wide: capitals [\d.]+ px tall \(least 12\)\.\n$/);
    expect(readFileSync(join(project, "cover.png")).subarray(1, 4).toString("latin1")).toBe("PNG");
    const json = JSON.parse(frameshell(["cover", "--text", "hook", "--json"]).stdout) as { path: string; source: string; readability: { readable: boolean } };
    expect(json).toMatchObject({ path: join(project, "exports", "main-cover.png"), source: "default", readability: { readable: true } });
    const long = frameshell(["cover", "--text", "la verdad sobre tiempo", "--at", "0.5", "--out", "long.png"]);
    expect(long.stdout).toContain("Not readable at 180 px wide");
    expect(long.stdout).toContain("warning: ");
  });

  it("refuses bad cover flags", () => {
    expect(frameshell(["cover", "--at", "soon"]).stderr).toMatch(/--at: expected seconds >= 0/);
    expect(frameshell(["cover", "--color", "yellow"]).stderr).toMatch(/--color: expected a colour like #ffd426/);
    expect(frameshell(["render", "--cover-text", "hook"]).stderr).toMatch(/only with --cover-frame/);
    expect(frameshell(["frame", "--at", "0", "--out", "x.png", "--text", "hook"]).stderr).toMatch(/does not take --text/);
  });

  it(
    "renders with --cover-frame: frame 0 becomes the cover",
    () => {
      const result = frameshell(["render", "--cover-frame", "--cover-text", "hook", "--cover-at", "0.5", "--out", "out/covered.mp4"]);
      expect(result.code, result.stderr).toBe(0);
      expect(existsSync(join(project, "out", "covered.mp4"))).toBe(true);
    },
    120_000,
  );

  it("makes an image project with init --kind image", () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-image-"))), "poster");
    const result = frameshell(["init", dir, "--kind", "image", "--no-skill"], tmpdir());
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"))).toMatchObject({ kind: "image" });
    expect(frameshell(["init", `${dir}-2`, "--kind", "poster"], tmpdir()).stderr).toMatch(/--kind: expected video or image/);
  });

  it("inspects a point: the clip under it, in fractions or pixels (ADR 0011)", () => {
    const text = frameshell(["inspect", "--at", "0.5", "--px", "960,540"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/^Point 0\.5,0\.5 \(960,540 px\) at 0\.5 s \(frame 15\) of main\n {2}c_[0-9a-f]{6} media \(seen\)\n$/);
    const json = frameshell(["inspect", "--at", "0.5", "--point", "0.25,0.75", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ x: 0.25, y: 0.75, pixel: { x: 480, y: 810 }, layers: [{ type: "media", paints: true }], elements: [] });
    const both = frameshell(["inspect", "--at", "0.5"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("--point <x,y>");
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
