import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryManager, type Daemon, startDaemon } from "@frameshell/core";
import { connectToDaemon } from "@frameshell/protocol";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";
import { installLocalPlugin } from "../../core/test/plugin-fixture.js";
import { toneWav } from "../../core/test/whisper-fixture.js";

// Black-box: the built CLI against an in-process daemon with the built `@frameshell/openai-transcription` plugin
// (`tsc -b` first) and a stub HTTP server. The real API is never called; KEY is a fake.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL("../../../plugins/openai-transcription/", import.meta.url));
const KEY = "sk-proj-FAKEKEY-cli-transcription-0123456789";
const VARIABLES = ["OPENAI_API_KEY", "FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL"] as const;

let daemon: Daemon;
let server: Server;
let socketPath: string;
let dirs: { dataDir: string; configDir: string };
let project: string;
let uploads = 0;
const saved = VARIABLES.map((name) => [name, process.env[name]] as const);

/** Async on purpose: a sync spawn would block the in-process daemon the child talks to. */
function frameshell(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd: project,
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_DATA_DIR: dirs.dataDir, FRAMESHELL_CONFIG_DIR: dirs.configDir },
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

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      uploads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "Hola.", language: "spanish", words: [{ word: "Hola", start: 0.3, end: 0.7 }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The daemon runs in this process: the provider reads these from its environment.
  process.env.OPENAI_API_KEY = KEY;
  process.env.FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  socketPath = uniqueSocketPath();
  dirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({
    socketPath,
    dirs,
    binaries: new BinaryManager(dirs),
    extractAudio: async (_input, output) => writeFileSync(output, toneWav(2, [[0.3, 0.7]])),
  });
  project = join(tempDir(), "talk");
  const conn = await connectToDaemon(socketPath, { client: "test" });
  await conn.request("project.init", { dir: project });
  mkdirSync(join(project, "assets"), { recursive: true });
  writeFileSync(join(project, "assets", "voice.mp4"), "voice");
  const plugin = join(tempDir(), "openai-transcription");
  mkdirSync(plugin);
  for (const entry of ["frameshell-plugin.json", "package.json", "dist", "skills"]) cpSync(join(PLUGIN_DIR, entry), join(plugin, entry), { recursive: true });
  installLocalPlugin(project, plugin, "@frameshell/openai-transcription");
  await conn.request("project.trust", { cwd: project, decision: "trust" });
  conn.close();
});

afterAll(async () => {
  await daemon?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("frameshell transcribe with a cloud provider", () => {
  it("refuses with the upload and cost, prints the confirming command, and transcribes when it is run", async () => {
    const refused = await frameshell(["transcribe", "assets/voice.mp4", "--provider", "openai", "--language", "es"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/uploads its audio \(0:02 of audio\) to that service and costs about 0\.0002 USD/);
    const printed = /Once the person confirmed: (frameshell transcribe .*)$/m.exec(refused.stderr)?.[1];
    expect(printed).toMatch(/^frameshell transcribe assets\/voice\.mp4 --provider openai --language es --yes --confirmation [0-9a-f]{32}$/);
    expect(uploads).toBe(0);

    const confirmed = await frameshell(printed!.split(" ").slice(1));
    expect(confirmed.stderr).not.toContain(KEY);
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toMatch(/^Transcribed assets\/voice\.mp4 -> transcripts\/voice\.words\.json\n/);
    expect(uploads).toBe(1);
  });

  it("exits 2 for --confirmation without --yes, and for --yes with --verify or --speakers", async () => {
    expect((await frameshell(["transcribe", "assets/voice.mp4", "--confirmation", "abc"])).code).toBe(2);
    expect((await frameshell(["transcribe", "--verify", "exports/x.mp4", "--yes"])).code).toBe(2);
    expect((await frameshell(["transcribe", "--speakers", "assets/voice.mp4", "--yes"])).code).toBe(2);
    expect(uploads).toBe(1);
  });
});
