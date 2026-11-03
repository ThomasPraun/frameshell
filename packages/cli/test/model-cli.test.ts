import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and auto-started daemon (#427). Model files are tiny stand-ins; nothing is transcribed.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-model-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-mo-${randomUUID().slice(0, 8)}.sock`);
let parent: string;
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
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), "frameshell-model-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  mkdirSync(userDirs, { recursive: true });
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
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

describe("frameshell model", () => {
  it("rejects bad arguments with exit 2", () => {
    for (const args of [["model"], ["model", "add", "x"], ["model", "list", "extra"], ["model", "remove"], ["model", "list", "--dtw", "small"], ["model", "use"]]) {
      expect(frameshell(args).code, args.join(" ")).toBe(2);
    }
  });

  it("registers a file relative to the working directory, lists it, makes it the default and forgets it", () => {
    writeFileSync(join(project, "ggml-es.bin"), "lmggweights");
    const added = frameshell(["model", "add", "es", "ggml-es.bin", "--dtw", "small", "--json"]);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ model: { id: "es", file: join(project, "ggml-es.bin"), format: "ggml", options: { dtw: "small" } }, replaced: false });
    expect(JSON.parse(readFileSync(join(userDirs, "models.json"), "utf8")).models.es.file).toBe(join(project, "ggml-es.bin"));

    const listed = frameshell(["model", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/es {2}ggml .*dtw=small/);
    expect(listed.stdout).toMatch(/This project: whisper-cpp \(no transcription\.model\)/);

    expect(frameshell(["model", "default", "es"]).stdout).toMatch(/Default model of whisper-cpp on this machine: es \(was none\)/);
    expect(JSON.parse(frameshell(["model", "list", "--json"]).stdout)).toMatchObject({ defaults: { "whisper-cpp": "es" }, project: { effective: "es" } });

    const removed = frameshell(["model", "remove", "es"]);
    expect(removed.stdout).toMatch(/Forgot model es .*\n {2}no longer the default of whisper-cpp/);
    expect(frameshell(["model", "remove", "es"]).stderr).toMatch(/"es" is not registered on this machine/);
  });

  it("refuses pickle checkpoints", () => {
    writeFileSync(join(project, "canary.nemo"), "tar");
    const result = frameshell(["model", "add", "canary", "canary.nemo"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/pickle-based checkpoint/);
  });

  it("sets and clears the project's model in frameshell.json", () => {
    writeFileSync(join(project, "ggml-mine.bin"), "lmggmine");
    expect(frameshell(["model", "add", "mine", "ggml-mine.bin"]).code).toBe(0);
    const config = () => JSON.parse(readFileSync(join(project, "frameshell.json"), "utf8")) as { transcription?: unknown; name: string };
    expect(frameshell(["model", "use", "mine"]).stdout).toMatch(/Project model \(whisper-cpp\): mine \(was default\)/);
    expect(config().transcription).toEqual({ provider: "whisper-cpp", model: "mine" });
    expect(frameshell(["model", "use", "default"]).code).toBe(0);
    expect(config()).toMatchObject({ name: "promo", transcription: { provider: "whisper-cpp" } });
    expect(frameshell(["model", "use", "x"], parent).stderr).toMatch(/No Frameshell project/);
  });
});
