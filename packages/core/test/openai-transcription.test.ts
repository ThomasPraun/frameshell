import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";
import { installLocalPlugin } from "./plugin-fixture.js";
import { toneWav } from "./whisper-fixture.js";

// Seam under test: the built official `@frameshell/openai-transcription` plugin (`tsc -b` first) loaded by the real
// PluginHost and driven by `transcribe` and `transcribe.verify`, against a stub HTTP server. The real API is never
// called; KEY is a fake.
const PLUGIN_DIR = fileURLToPath(new URL("../../../plugins/openai-transcription/", import.meta.url));
const KEY = "sk-proj-FAKEKEY-core-transcription-0123456789";
const NAME = "@frameshell/openai-transcription";
const VARIABLES = ["OPENAI_API_KEY", "FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL"] as const;

describe("transcribe with the openai-transcription plugin", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let root: string;
  let requests: { authorization: string | undefined; bytes: number }[];
  let stop: () => Promise<void>;
  const saved = VARIABLES.map((name) => [name, process.env[name]] as const);

  beforeEach(async () => {
    requests = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ authorization: req.headers.authorization, bytes: Buffer.concat(chunks).length });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "Hola, mundo.", language: "spanish", words: [{ word: "Hola", start: 0.2, end: 0.6 }, { word: "mundo", start: 0.7, end: 1.2 }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    stop = () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
    process.env.OPENAI_API_KEY = KEY;
    process.env.FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    daemon = await startDaemon({
      socketPath: uniqueSocketPath(),
      idleTimeoutMs: Number.POSITIVE_INFINITY,
      dirs: { dataDir: tempDir(), configDir: tempDir() },
      binaries: testBinaryManager(),
    });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    root = join(tempDir(), "talk");
    await conn.request("project.init", { dir: root });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "voice.wav"), toneWav(3, [[0.2, 1.2]]));
    const plugin = join(tempDir(), "openai-transcription");
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

  const transcribeWith = (params: Record<string, unknown> = {}) => conn.request("transcribe", { cwd: root, asset: "assets/voice.wav", provider: "openai", ...params });
  const transcribe = transcribeWith;

  it("asks before uploading, transcribes only after `yes` with the token, and never writes the key into the project", async () => {
    const transcribe = (params: Record<string, unknown> = {}) => transcribeWith({ model: "whisper-1", ...params });
    const refused = await transcribe().then(() => null, (error: unknown) => error as RpcError);
    expect(refused).toBeInstanceOf(RpcError);
    expect(refused!.code).toBe(ErrorCode.ConfirmationRequired);
    expect(refused!.message).toMatch(/uploads its audio \(0:03 of audio\) to that service and costs about 0\.0003 USD/);
    expect(refused!.data).toMatchObject({ provider: "openai", asset: "assets/voice.wav", seconds: 3, remote: true, cost: { currency: "USD" } });
    expect(requests).toEqual([]);

    const stale = await transcribe({ yes: true, confirmation: "f".repeat(32) }).then(() => null, (error: unknown) => error as RpcError);
    expect(stale!.code).toBe(ErrorCode.ConfirmationStale);
    expect(requests).toEqual([]);

    const result = await transcribe({ yes: true, confirmation: (refused!.data as { confirmation: string }).confirmation });
    expect(result).toMatchObject({ provider: "openai", model: "whisper-1", language: "es", words: 2 });
    expect(result.warnings.join(" ")).toMatch(/coarser than whisper\.cpp/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe(`Bearer ${KEY}`);
    const transcript = JSON.parse(readFileSync(join(root, "transcripts", "voice.words.json"), "utf8"));
    expect(transcript.words.map((word: { text: string }) => word.text)).toEqual(["Hola,", "mundo."]);

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

  it("refuses another model before uploading", async () => {
    await expect(transcribe({ yes: true, model: "gpt-4o-transcribe" })).rejects.toMatchObject({
      code: ErrorCode.TranscriptionFailed,
      message: expect.stringContaining("only with gpt-transcribe or whisper-1"),
    });
    expect(requests).toEqual([]);
  });

  it("with the default text-only model, needs whisper.cpp for the times and fails before the ask without it", async () => {
    // No `@frameshell/whisper-cpp` in this project: the local timing cannot load, so nothing is asked or uploaded.
    await expect(transcribe({ yes: true })).rejects.toMatchObject({
      code: ErrorCode.TranscriptionFailed,
      message: expect.stringMatching(/gpt-transcribe gives no word times, which whisper\.cpp adds on this machine.*whisper-cpp/s),
    });
    expect(requests).toEqual([]);
  });

  it("is never used by `transcribe --verify`, even with `yes` elsewhere", async () => {
    mkdirSync(join(root, "exports"), { recursive: true });
    writeFileSync(join(root, "exports", "cut.wav"), toneWav(1, []));
    await expect(conn.request("transcribe.verify", { cwd: root, export: "exports/cut.wav", timeline: "main", provider: "openai" })).rejects.toMatchObject({
      code: ErrorCode.TranscriptionFailed,
      message: expect.stringMatching(/only `frameshell transcribe --yes` uses it/),
    });
    expect(requests).toEqual([]);
  });
});
