import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "@frameshell/core";
import { runCli } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";
import { type GitPlugin, gitPluginFixture } from "../../core/test/plugin-fixture.js";

// Black-box: the built CLI against in-process daemons, so each test picks its user (app dirs).
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const NPM_TIMEOUT = 120_000;

interface User {
  socketPath: string;
  daemon: Daemon;
}
const users: User[] = [];

async function newUser(): Promise<User> {
  const socketPath = uniqueSocketPath();
  const dirs = { dataDir: tempDir(), configDir: tempDir() };
  const user = { socketPath, daemon: await startDaemon({ socketPath, dirs }) };
  users.push(user);
  return user;
}

/** Async on purpose: a sync spawn would block the in-process daemon the child talks to. */
function frameshell(user: User, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd,
    env: { ...process.env, FRAMESHELL_SOCKET: user.socketPath },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** In-process run, for the interactive trust prompt a child process cannot fake. */
async function frameshellInteractive(user: User, args: string[], cwd: string, answer: string) {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const code = await runCli(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd,
    env: { ...process.env, FRAMESHELL_SOCKET: user.socketPath },
    prompt: async (question) => {
      questions.push(question);
      return answer;
    },
  });
  return { code, stdout, stderr, questions };
}

let hello: GitPlugin;
let author: User;
let project: string;

beforeAll(async () => {
  hello = gitPluginFixture();
  author = await newUser();
  project = tempDir();
  expect((await frameshell(author, ["init"], project)).code).toBe(0);
});
afterAll(async () => {
  await Promise.all(users.map((u) => u.daemon.close()));
});

describe("frameshell plugin", () => {
  it(
    "install pins the plugin in frameshell.json and reports what it contributes",
    async () => {
      const result = await frameshell(author, ["plugin", "install", hello.spec], project);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello-plugin");
      expect(result.stdout).toContain("hello greet");
      expect(result.stdout).toContain(hello.sha);
      const config = JSON.parse(readFileSync(join(project, "frameshell.json"), "utf8"));
      expect(config.plugins).toEqual({ "hello-plugin": `${hello.spec}#${hello.sha}` });
    },
    NPM_TIMEOUT,
  );

  it("list --json shows the loaded plugin", async () => {
    const result = await frameshell(author, ["plugin", "list", "--json"], project);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      trust: "trusted",
      plugins: [{ name: "hello-plugin", status: "loaded", contributes: { exportPresets: ["hello-square"] } }],
    });
  });

  it("runs a plugin command as `frameshell <plugin> <command>`", async () => {
    const result = await frameshell(author, ["hello", "greet", "Ana"], join(project, "assets"));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Hello, Ana!\n");
  });

  it("prints the command's data with --json, without passing the flag to the plugin", async () => {
    const result = await frameshell(author, ["hello", "greet", "--json", "Ana"], project);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ output: "Hello, Ana!", data: { greeted: "Ana", project } });
  });

  it("exits 2 and lists plugin commands for an unknown one", async () => {
    const result = await frameshell(author, ["hello", "wave"], project);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("hello greet");
  });

  it("exits 1 with the plugin's message when its command fails", async () => {
    const result = await frameshell(author, ["hello", "greet", "--fail"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("greeting refused");
  });
});

describe("trust at the CLI", () => {
  it("refuses to run plugins of an untrusted project when it cannot ask, pointing at --trust", async () => {
    const stranger = await newUser();
    const result = await frameshell(stranger, ["hello", "greet"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not trusted/);
    expect(result.stderr).toContain("--trust");

    const list = await frameshell(stranger, ["plugin", "list"], project);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/not trusted/);
  });

  it("--trust records trust and runs the command", async () => {
    const stranger = await newUser();
    const result = await frameshell(stranger, ["hello", "greet", "Bo", "--trust"], project);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Hello, Bo!\n");
    // Remembered: no flag needed next time.
    expect((await frameshell(stranger, ["hello", "greet", "Bo"], project)).code).toBe(0);
  });

  it("asks once, naming the plugins, and loads them on yes", async () => {
    const stranger = await newUser();
    const first = await frameshellInteractive(stranger, ["hello", "greet", "Cy"], project, "y");
    expect(first.questions).toHaveLength(1);
    expect(first.questions[0]).toContain("hello-plugin");
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("Hello, Cy!\n");

    const second = await frameshellInteractive(stranger, ["hello", "greet", "Cy"], project, "y");
    expect(second.questions).toHaveLength(0);
  });

  it("keeps plugins off on no, and does not ask again", async () => {
    const stranger = await newUser();
    const first = await frameshellInteractive(stranger, ["hello", "greet"], project, "n");
    expect(first.code).toBe(1);
    expect(first.stderr).toMatch(/denied/);

    const second = await frameshellInteractive(stranger, ["hello", "greet"], project, "y");
    expect(second.questions).toHaveLength(0);
    expect(second.code).toBe(1);
  });

  it("status shows the project's trust state", async () => {
    const stranger = await newUser();
    const result = await frameshell(stranger, ["status"], project);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Plugins: 1 declared, not trusted/);
  });
});
