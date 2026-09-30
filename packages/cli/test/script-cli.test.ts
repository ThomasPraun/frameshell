import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and auto-started daemon on a project with a script and hand-written clips.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-script-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-sc-${randomUUID().slice(0, 8)}.sock`);
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
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-script-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  expect(frameshell(["init", project], parent).code).toBe(0);
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(
    join(project, "scripts", "promo.md"),
    ["---", "title: Promo", "target_duration: 60", "aspect: '9:16'", "---", "## Hook", "Stop scrolling.", "## ¿Por qué?", "Because.", "## Hook", "Again."].join("\n"),
  );
  const clip = (id: string, start: number, scriptRef?: string) => ({ id, type: "titles", start, duration: 1, ...(scriptRef ? { scriptRef } : {}) });
  writeFileSync(
    join(project, "timelines", "main.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "main",
      revision: 0,
      tracks: [{ id: "t_v", kind: "video", clips: [clip("c_hook", 0, "scripts/promo.md#hook"), clip("c_free", 2)] }],
    }),
  );
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

describe("frameshell script outline", () => {
  it("prints scenes with anchors, linked clips and warnings", () => {
    const result = frameshell(["script", "outline", "promo.md"], join(project, "scripts"));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'scripts/promo.md · "Promo" · target 60 s · 9:16 · 3 scenes',
        "  #hook     Hook       line 6   2 words  clips: main/c_hook",
        "  #por-qué  ¿Por qué?  line 8   1 word  no clips",
        "  #hook-1   Hook       line 10  1 word  no clips",
        "Warnings:",
        '  Heading "Hook" appears 2 times; anchors hook, hook-1. Give scenes distinct headings so scriptRefs do not shift when one is removed.',
        "",
      ].join("\n"),
    );
  });

  it("prints the outline as JSON with --json", () => {
    const result = frameshell(["script", "outline", "scripts/promo.md", "--json"]);
    expect(result.code).toBe(0);
    const outline = JSON.parse(result.stdout);
    expect(outline.meta).toEqual({ title: "Promo", targetDuration: 60, aspect: "9:16" });
    expect(outline.scenes.map((scene: { ref: string }) => scene.ref)).toEqual([
      "scripts/promo.md#hook",
      "scripts/promo.md#por-qué",
      "scripts/promo.md#hook-1",
    ]);
  });

  it("fails with the scripts there are when the file is missing, and exits 2 on bad usage", () => {
    const missing = frameshell(["script", "outline", "scripts/nope.md"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/No script scripts\/nope\.md.*scripts: scripts\/promo\.md/);
    expect(frameshell(["script", "outline"]).code).toBe(2);
  });
});

describe("frameshell clip set --script-ref", () => {
  it("links a clip to a scene, warning but storing when the scene does not exist", () => {
    const ok = frameshell(["clip", "set", "c_free", "--script-ref", "scripts/promo.md#por-qué"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).not.toMatch(/warning/);

    const missing = frameshell(["clip", "set", "c_free", "--script-ref", "scripts/promo.md#outro"]);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toMatch(/^warning: scriptRef "scripts\/promo\.md#outro": no scene "outro".*hook, por-qué, hook-1/m);
    const outline = JSON.parse(frameshell(["script", "outline", "scripts/promo.md", "--json"]).stdout);
    expect(outline.unresolved).toEqual([{ timeline: "main", clip: "c_free", scriptRef: "scripts/promo.md#outro" }]);
    expect(frameshell(["script", "outline", "scripts/promo.md"]).stdout).toMatch(/Unresolved refs:\n {2}main\/c_free -> scripts\/promo\.md#outro\n/);
  });

  it("links a clip to the whole script when the ref has no anchor", () => {
    const whole = frameshell(["clip", "set", "c_free", "--script-ref", "scripts/promo.md"]);
    expect(whole.code).toBe(0);
    expect(whole.stdout).not.toMatch(/warning/);
    expect(frameshell(["script", "outline", "scripts/promo.md"]).stdout).toMatch(/^ {2}whole script {2}clips: main\/c_free$/m);
    expect(JSON.parse(frameshell(["script", "outline", "scripts/promo.md", "--json"]).stdout).clips).toEqual([{ timeline: "main", clip: "c_free" }]);

    const missing = frameshell(["clip", "set", "c_free", "--script-ref", "scripts/later.md"]);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toMatch(/^warning: scriptRef "scripts\/later\.md": scripts\/later\.md does not exist/m);
  });
});
