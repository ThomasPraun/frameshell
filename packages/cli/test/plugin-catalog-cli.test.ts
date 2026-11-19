import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, BinaryManager, startDaemon } from "@frameshell/core";
import { OFFICIAL_PLUGINS } from "@frameshell/protocol";
import { runCli } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";

// In-process run against a daemon with empty app dirs: nothing is installed or downloaded, only read.
let daemon: Daemon;
let socketPath: string;
let project: string;

async function frameshell(args: string[], cwd = project) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd,
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath },
  });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  socketPath = uniqueSocketPath();
  const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), standardPaths: false });
  daemon = await startDaemon({ socketPath, binaries });
  project = tempDir();
  // The daemon runs in this process: a key in the developer's shell must not change the output.
  delete process.env.OPENAI_API_KEY;
  expect((await frameshell(["init", "."])).code).toBe(0);
});

afterAll(async () => {
  await daemon.close();
});

describe("frameshell plugin catalog", () => {
  it("prints every official plugin with its need, download and install command", async () => {
    const { code, stdout, stderr } = await frameshell(["plugin", "catalog"]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    for (const plugin of OFFICIAL_PLUGINS) expect(stdout).toContain(`${plugin.name}  not installed`);
    expect(stdout).toContain("needs: Nothing: it runs on this computer and uploads nothing.");
    expect(stdout).toMatch(/needs: Your own OpenAI API key .* \[not found yet\]/);
    expect(stdout).toContain("paid per use, data leaves this computer");
    expect(stdout).toMatch(/download: \d+ MB on first use \(whisper-cpp \d+ MB, ggml-large-v3-turbo-q5_0 574 MB\)/);
    expect(stdout).toContain("install: frameshell plugin install @frameshell/blender");
    expect(stdout).toContain("Installing any of them is optional.");
  });

  it("--json prints the method result", async () => {
    const { code, stdout } = await frameshell(["plugin", "catalog", "--json"]);
    const result = JSON.parse(stdout);
    expect(code).toBe(0);
    expect(result.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(OFFICIAL_PLUGINS.map((plugin) => plugin.name));
    expect(result.trust).toBe("not-required");
  });

  it("takes no argument", async () => {
    expect((await frameshell(["plugin", "catalog", "extra"])).code).toBe(2);
  });
});
