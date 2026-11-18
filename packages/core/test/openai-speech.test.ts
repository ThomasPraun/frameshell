import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";
import { installLocalPlugin } from "./plugin-fixture.js";
import { toneWav } from "./whisper-fixture.js";

// Seam under test: the built official `@frameshell/openai-speech` plugin (`tsc -b` first) loaded by the real
// PluginHost and driven by `voiceover.generate`, against a stub HTTP server. The real API is never called; KEY is a fake.
const PLUGIN_DIR = fileURLToPath(new URL("../../../plugins/openai-speech/", import.meta.url));
const KEY = "sk-proj-FAKEKEY-core-0123456789";
const NAME = "@frameshell/openai-speech";
const VARIABLES = ["OPENAI_API_KEY", "FRAMESHELL_OPENAI_SPEECH_BASE_URL", "FRAMESHELL_OPENAI_SPEECH_MODEL"] as const;

describe("voiceover.generate with the openai-speech plugin", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let root: string;
  let requests: { authorization: string | undefined; body: Record<string, unknown> }[];
  let stop: () => Promise<void>;
  const saved = VARIABLES.map((name) => [name, process.env[name]] as const);

  beforeEach(async () => {
    requests = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(toneWav(1, [[0.2, 0.8]]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    stop = () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
    process.env.OPENAI_API_KEY = KEY;
    process.env.FRAMESHELL_OPENAI_SPEECH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    delete process.env.FRAMESHELL_OPENAI_SPEECH_MODEL;

    daemon = await startDaemon({
      socketPath: uniqueSocketPath(),
      idleTimeoutMs: Number.POSITIVE_INFINITY,
      dirs: { dataDir: tempDir(), configDir: tempDir() },
      binaries: testBinaryManager(),
    });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    root = join(tempDir(), "launch");
    await conn.request("project.init", { dir: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "vo.md"), ["---", "voiceover: true", "language: es", "provider: openai", "---", "## Hook", "Son 23 pestañas."].join("\n"));
    const plugin = join(tempDir(), "openai-speech");
    mkdirSync(plugin);
    for (const entry of ["frameshell-plugin.json", "package.json", "dist", "skills"]) cpSync(join(PLUGIN_DIR, entry), join(plugin, entry), { recursive: true });
    installLocalPlugin(root, plugin, NAME);
    await conn.request("project.trust", { cwd: root, decision: "trust" });
  });

  afterEach(async () => {
    conn.close();
    await daemon.close();
    await stop();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const generate = (params: Record<string, unknown> = {}) => conn.request("voiceover.generate", { cwd: root, script: "scripts/vo.md", ...params });

  it("asks for the cost first, says the line only after `yes`, and never writes the key into the project", async () => {
    const refused = generate();
    await expect(refused).rejects.toMatchObject({
      code: ErrorCode.ConfirmationRequired,
      data: { provider: "openai", voice: "alloy", lines: ["hook-1"], cost: { amount: expect.any(Number), currency: "USD" } },
    });
    const asked = await refused.then(() => null, (error: { data: { cost: { amount: number } } }) => error.data);
    expect(asked!.cost.amount).toBeGreaterThan(0);
    expect(requests).toEqual([]);

    const result = await generate({ yes: true });
    expect(result.lines.map((line) => line.state)).toEqual(["generated"]);
    expect(requests).toHaveLength(1);
    // "Son 23 pestañas." goes out in its spoken form: the number spelled in Spanish.
    expect(requests[0]).toMatchObject({ authorization: `Bearer ${KEY}`, body: { model: "gpt-4o-mini-tts", voice: "alloy", response_format: "wav", input: "Son veintitrés pestañas." } });

    const leaked: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) scan(path);
        else if (readFileSync(path).includes(KEY)) leaked.push(path);
      }
    };
    scan(root);
    expect(leaked).toEqual([]);
  });

  it("reports a missing key as SpeechFailed naming the variable", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generate({ yes: true })).rejects.toMatchObject({ code: ErrorCode.SpeechFailed, message: expect.stringContaining("OPENAI_API_KEY is not set") });
    expect(requests).toEqual([]);
  });
});
