import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobInfo } from "@frameshell/protocol";
import { formatJob } from "../src/job-commands.js";

// Black-box: built CLI and auto-started daemon on an empty project. Real queued renders are covered in core.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-job-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-jb-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[]) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: "1500", FRAMESHELL_DATA_DIR: userDirs, FRAMESHELL_CONFIG_DIR: userDirs },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-job-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  const init = spawnSync(process.execPath, [cliBin, "init", project, "--no-skill"], {
    cwd: parent,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: "1500", FRAMESHELL_DATA_DIR: userDirs, FRAMESHELL_CONFIG_DIR: userDirs },
  });
  expect(init.status, init.stderr).toBe(0);
  daemonPid = (JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } }).daemon.pid;
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

const job = (patch: Partial<JobInfo>): JobInfo => ({
  id: "j_c3",
  kind: "clip",
  project: "/p",
  asset: "compositions/intro/index.html",
  output: null,
  priority: "interactive",
  position: null,
  state: "queued",
  step: null,
  progress: 0,
  cached: null,
  error: null,
  warnings: [],
  createdAt: "2026-11-14T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...patch,
});

describe("frameshell job", () => {
  it("lists jobs, and says when there are none", () => {
    expect(frameshell(["job", "list"])).toMatchObject({ code: 0, stdout: "No jobs.\n" });
    const json = frameshell(["job", "list", "--active", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ jobs: [] });
  });

  it("refuses to cancel a job that does not exist, with the way out", () => {
    const result = frameshell(["job", "cancel", "j_c999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no job j_c999 in this project");
  });

  it("rejects a wrong shape, and --active on cancel", () => {
    expect(frameshell(["job"]).code).toBe(2);
    expect(frameshell(["job", "cancel"]).code).toBe(2);
    expect(frameshell(["job", "cancel", "j_c1", "--active"]).code).toBe(2);
  });
});

describe("formatJob", () => {
  it("shows a queued job's place in line, and that it waits as background", () => {
    expect(formatJob(job({ position: 1 }))).toBe("clip compositions/intro/index.html: queued #1 (j_c3)");
    expect(formatJob(job({ position: 3, priority: "background" }))).toBe("clip compositions/intro/index.html: queued #3 (background) (j_c3)");
    expect(formatJob(job({ state: "canceled" }))).toBe("clip compositions/intro/index.html: canceled (j_c3)");
  });
});
