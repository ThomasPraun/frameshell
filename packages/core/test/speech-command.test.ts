import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import type { SpeechProvider } from "@frameshell/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, commandSpeechProvider, readCommandSpeechProvider, readGlobalConfig, standInSpeechProvider, startDaemon, takeMarkOf } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: the machine-level `command` speech provider (ADR 0034 slice 2), read from the global config
// only, driven by a stub TTS program (node, so it runs on every platform), and the free-or-paid rule.

const STUB = fileURLToPath(new URL("./fixtures/speech-command/tts.mjs", import.meta.url));
const node = process.execPath;

const context = (outDir: string, signal = new AbortController().signal) => ({ outDir, signal, ensureBinary: async () => "", progress: () => {} });

function logLines(file: string): { text: string; argv: string[] }[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

describe("commandSpeechProvider", () => {
  let configDir: string;
  let outDir: string;
  beforeEach(() => {
    configDir = tempDir();
    outDir = tempDir();
  });

  it("sends the text on stdin, fills {voice}, {language} and {out}, and returns the WAV", async () => {
    const log = join(outDir, "log.txt");
    const provider = commandSpeechProvider({ run: [node, STUB, "--voice", "{voice}", "--lang={language}", "--log", log, "--out", "{out}"], voices: ["tone", { id: "low", label: "Low" }], defaultVoice: "tone" }, configDir);
    expect(provider).toMatchObject({ id: "command", free: true, version: "1", defaultVoice: "tone" });
    expect(await provider.voices()).toEqual([{ id: "tone" }, { id: "low", label: "Low" }]);
    expect(provider.estimate).toBeUndefined();
    const result = await provider.synthesize("hola a todos", "low", { language: "es" }, context(outDir));
    expect(result.file).toBe(join(outDir, "take.wav"));
    expect(readFileSync(result.file).subarray(0, 4).toString()).toBe("RIFF");
    expect(logLines(log)).toEqual([{ text: "hola a todos", argv: ["--voice", "low", "--lang=es", "--log", log, "--out", result.file] }]);
  });

  it("takes the WAV from stdout when no argument has {out}", async () => {
    const provider = commandSpeechProvider({ run: [node, STUB, "--stdout"] }, configDir);
    const result = await provider.synthesize("uno dos tres", "any", {}, context(outDir));
    // 0.2 s + 3 * 0.15 s + 0.2 s of 16 kHz mono 16-bit, plus the 44-byte header.
    expect(readFileSync(result.file).length).toBe(44 + Math.round(0.85 * 16000) * 2);
  });

  it("reports the program's exit code and stderr", async () => {
    const provider = commandSpeechProvider({ run: [node, STUB, "--out", "{out}"] }, configDir);
    await expect(provider.synthesize("explode now", "v", {}, context(outDir))).rejects.toThrow(/exited with code 3: the voice broke/);
  });

  it("names the config file when the program is not found", async () => {
    const provider = commandSpeechProvider({ run: ["frameshell-no-such-tts", "{out}"] }, configDir);
    await expect(provider.synthesize("hola", "v", {}, context(outDir))).rejects.toThrow(/could not start frameshell-no-such-tts: not found.*config\.json/s);
  });

  it("stops a program that runs past timeoutSeconds", async () => {
    const provider = commandSpeechProvider({ run: [node, STUB, "--out", "{out}"], timeoutSeconds: 0.5 }, configDir);
    await expect(provider.synthesize("hang", "v", {}, context(outDir))).rejects.toThrow(/longer than 0\.5 s/);
  });

  it("stops a program when the daemon aborts", async () => {
    const provider = commandSpeechProvider({ run: [node, STUB, "--out", "{out}"] }, configDir);
    const controller = new AbortController();
    const pending = provider.synthesize("hang", "v", {}, context(outDir, controller.signal));
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/stopped/);
  });

  it("runs nothing for a voice or language that starts with a dash", async () => {
    const log = join(outDir, "log.txt");
    const provider = commandSpeechProvider({ run: [node, STUB, "--log", log, "--voice", "{voice}", "--out", "{out}"] }, configDir);
    await expect(provider.synthesize("hola", "--out=/tmp/x", {}, context(outDir))).rejects.toThrow(/voice "--out=\/tmp\/x" is not accepted/);
    const withLanguage = commandSpeechProvider({ run: [node, STUB, "--log", log, "--out", "{out}", "{language}"] }, configDir);
    await expect(withLanguage.synthesize("hola", "v", { language: "-x" }, context(outDir))).rejects.toThrow(/language "-x" is not accepted/);
    await expect(withLanguage.synthesize("hola", "v", {}, context(outDir))).rejects.toThrow(/uses \{language\} but the script has no `language:`/);
    expect(logLines(log)).toEqual([]);
  });

  describe.skipIf(process.platform === "win32")("an executable script", () => {
    it("resolves a relative program against the config dir and runs it", async () => {
      mkdirSync(join(configDir, "bin"));
      const script = join(configDir, "bin", "say.sh");
      writeFileSync(script, `#!/bin/sh\ncat > "$1.text"\n${JSON.stringify(node)} ${JSON.stringify(STUB)} --out "$1" < "$1.text"\n`);
      chmodSync(script, 0o755);
      const provider = commandSpeechProvider({ run: ["./bin/say.sh", "{out}"] }, configDir);
      const result = await provider.synthesize("hola", "v", {}, context(outDir));
      expect(readFileSync(result.file).subarray(0, 4).toString()).toBe("RIFF");
    });
  });
});

describe("the global config", () => {
  it("is read from speech.command, and a missing or empty file means no command provider", async () => {
    const configDir = tempDir();
    expect(await readCommandSpeechProvider(configDir)).toBeNull();
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ binaries: {} }));
    expect(await readCommandSpeechProvider(configDir)).toBeNull();
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ speech: { command: { run: ["tts"], version: "3" } } }));
    expect(await readCommandSpeechProvider(configDir)).toMatchObject({ id: "command", version: "3" });
  });

  it.each([
    [{ speech: { command: { run: [] } } }, "speech.command.run"],
    [{ speech: { command: { run: ["tts"], shell: true } } }, "speech.command"],
    [{ speech: { other: {} } }, "speech"],
  ])("refuses %j as InvalidGlobalConfig", async (config, where) => {
    const configDir = tempDir();
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
    await expect(readGlobalConfig(configDir)).rejects.toMatchObject({ code: ErrorCode.InvalidGlobalConfig, message: expect.stringContaining(where) });
  });
});

describe("voiceover.generate with the command provider", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let root: string;
  let configDir: string;
  let log: string;

  const start = async (extra: SpeechProvider[] = []) => {
    daemon = await startDaemon({
      socketPath: uniqueSocketPath(),
      idleTimeoutMs: Number.POSITIVE_INFINITY,
      speechProviders: extra,
      dirs: { dataDir: tempDir(), configDir },
      binaries: testBinaryManager(),
    });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    root = join(tempDir(), "launch");
    await conn.request("project.init", { dir: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "vo.md"), ["---", "voiceover: true", "language: es", "provider: command", "---", "## Hook", "Son 23 pestañas.", "## Fix", "Las cierra."].join("\n"));
  };
  const configure = (command: object) => writeFileSync(join(configDir, "config.json"), JSON.stringify({ speech: { command } }));
  const generate = (params: Record<string, unknown> = {}) => conn.request("voiceover.generate", { cwd: root, script: "scripts/vo.md", ...params });

  beforeEach(() => {
    configDir = tempDir();
    log = join(tempDir(), "log.txt");
  });
  afterEach(async () => {
    conn.close();
    await daemon.close();
  });

  it("says the lines with the user's program, free (no --yes), cached the second time", async () => {
    configure({ run: [node, STUB, "--voice", "{voice}", "--log", log, "--out", "{out}"], voices: ["tone", "low"], defaultVoice: "tone", version: "7" });
    await start();
    const result = await generate();
    expect(result).toMatchObject({ provider: "command", voice: "tone", cost: null });
    expect(result.lines.map((line) => [line.id, line.state])).toEqual([["hook-1", "generated"], ["fix-1", "generated"]]);
    expect(logLines(log).map((entry) => entry.text)).toEqual(["Son veintitrés pestañas.", "Las cierra."]);
    const take = readFileSync(join(root, "assets", "voiceover", "vo", "hook-1.wav"));
    expect(takeMarkOf(take)).toMatchObject({ provider: "command", voice: "tone", text: "Son veintitrés pestañas." });
    expect(result.lines[0]!.trimmed.head).toBeCloseTo(0.18, 2);
    expect((await generate()).lines.map((line) => line.state)).toEqual(["cached", "cached"]);
    expect(logLines(log)).toHaveLength(2);
    await expect(generate({ voice: "soprano" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("voices: tone, low") });
  });

  it("applies an edit of config.json without restarting, and a new version says the lines again", async () => {
    configure({ run: [node, STUB, "--log", log, "--out", "{out}"], defaultVoice: "tone" });
    await start();
    await generate();
    configure({ run: [node, STUB, "--log", log, "--out", "{out}"], defaultVoice: "tone", version: "2" });
    expect((await generate()).lines.map((line) => line.state)).toEqual(["generated", "generated"]);
  });

  it("is not there until set up, and the error says where to set it up", async () => {
    await start([standInSpeechProvider()]);
    await expect(generate()).rejects.toMatchObject({
      code: ErrorCode.SpeechProviderNotFound,
      data: { provider: "command", available: ["stand-in"] },
      message: expect.stringMatching(/config\.json.*never from frameshell\.json/s),
    });
  });

  it("fails with SpeechFailed when the program fails, writing nothing", async () => {
    configure({ run: [node, STUB, "--out", "{out}"], defaultVoice: "tone" });
    await start();
    writeFileSync(join(root, "scripts", "vo.md"), ["---", "voiceover: true", "provider: command", "---", "## Hook", "Please explode."].join("\n"));
    await expect(generate()).rejects.toMatchObject({ code: ErrorCode.SpeechFailed, data: { provider: "command", line: "hook-1", details: expect.stringContaining("the voice broke") } });
    expect(existsSync(join(root, "assets", "voiceover", "vo", "hook-1.wav"))).toBe(false);
  });

  it("refuses a speech command in frameshell.json", async () => {
    configure({ run: [node, STUB, "--out", "{out}"], defaultVoice: "tone" });
    await start();
    const file = join(root, "frameshell.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...config, speech: { command: { run: ["touch", "pwned"] } } }));
    await expect(generate()).rejects.toMatchObject({ message: expect.stringContaining("speech") });
    expect(existsSync(join(root, "assets", "voiceover"))).toBe(false);
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});

describe("free or paid", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let root: string;
  let said: number;

  beforeEach(async () => {
    said = 0;
    const standIn = standInSpeechProvider();
    const counted = (id: string, extra: Partial<SpeechProvider>): SpeechProvider => {
      const { free: _free, ...base } = standIn;
      return { ...base, id, synthesize: (text, voice, options, ctx) => (said++, standIn.synthesize(text, voice, options, ctx)), ...extra };
    };
    daemon = await startDaemon({
      socketPath: uniqueSocketPath(),
      idleTimeoutMs: Number.POSITIVE_INFINITY,
      speechProviders: [
        counted("unknown-cost", {}),
        counted("declared-free", { free: true }),
        counted("zero-estimate", { estimate: () => ({ cost: 0, currency: "USD" }) }),
        counted("estimate-beats-free", { free: true, estimate: () => ({ cost: 0.5, currency: "USD" }) }),
      ],
      dirs: { dataDir: tempDir(), configDir: tempDir() },
      binaries: testBinaryManager(),
    });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    root = join(tempDir(), "launch");
    await conn.request("project.init", { dir: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "vo.md"), ["---", "voiceover: true", "---", "## Hook", "Hola a todos."].join("\n"));
  });
  afterEach(async () => {
    conn.close();
    await daemon.close();
  });
  const generate = (provider: string, params: Record<string, unknown> = {}) => conn.request("voiceover.generate", { cwd: root, script: "scripts/vo.md", provider, ...params });

  it("counts a provider with no estimate and no free flag as paid, at an unknown cost", async () => {
    await expect(generate("unknown-cost")).rejects.toMatchObject({
      code: ErrorCode.ConfirmationRequired,
      data: { provider: "unknown-cost", lines: ["hook-1"], cost: null, characters: 13 },
      message: expect.stringContaining("may cost money"),
    });
    expect(said).toBe(0);
    expect((await generate("unknown-cost", { yes: true })).cost).toBeNull();
    expect(said).toBe(1);
    // Nothing left to say: cached lines need no confirmation.
    expect((await generate("unknown-cost")).lines.map((line) => line.state)).toEqual(["cached"]);
  });

  it("does not ask for a provider that declares itself free, or whose estimate is 0", async () => {
    expect((await generate("declared-free")).lines[0]!.state).toBe("generated");
    expect((await generate("zero-estimate")).cost).toEqual({ amount: 0, currency: "USD" });
  });

  it("lets the estimate decide when a provider has both", async () => {
    await expect(generate("estimate-beats-free")).rejects.toMatchObject({ code: ErrorCode.ConfirmationRequired, data: { cost: { amount: 0.5, currency: "USD" } } });
  });
});
