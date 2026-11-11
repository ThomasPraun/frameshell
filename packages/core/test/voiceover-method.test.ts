import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import type { SpeechProvider } from "@frameshell/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, standInSpeechProvider, startDaemon, takeMarkOf } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";
import { installLocalPlugin } from "./plugin-fixture.js";

// Seam under test: `voiceover.generate` (ADR 0034) through a real in-process daemon, with the stand-in provider
// (counted) as the built-in speech provider and a paid provider from a plugin.

const SPEECH_PLUGIN = fileURLToPath(new URL("./fixtures/speech-plugin/", import.meta.url));

const script = (lines: string[], frontmatter: string[] = ["provider: stand-in"]) =>
  ["---", "title: Launch", "voiceover: true", "language: es", ...frontmatter, "---", ...lines].join("\n");
const LINES = ["## Hook", "Son 23 pestañas.", "[VISUAL: tabs]", "## Fix", "{Frameshell|freim shel} las cierra."];

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;
let said: string[];

beforeEach(async () => {
  said = [];
  const standIn = standInSpeechProvider();
  const counted: SpeechProvider = { ...standIn, synthesize: (text, voice, options, context) => (said.push(text), standIn.synthesize(text, voice, options, context)) };
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    speechProviders: [counted],
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch-vo.md"), script(LINES));
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const generate = (params: Record<string, unknown> = {}, options = {}) =>
  conn.request("voiceover.generate", { cwd: root, script: "scripts/launch-vo.md", ...params }, options);
const take = (id: string) => join(root, "assets", "voiceover", "launch-vo", `${id}.wav`);

describe("voiceover.generate", () => {
  it("says each line once into assets/voiceover, trimmed and marked, and imports the takes together", async () => {
    const result = await generate();
    expect(result).toMatchObject({ script: "scripts/launch-vo.md", dir: "assets/voiceover/launch-vo", provider: "stand-in", voice: "tone", cost: null, warnings: [] });
    expect(result.lines.map(({ id, state, file, display, spoken }) => ({ id, state, file, display, spoken }))).toEqual([
      { id: "hook-1", state: "generated", file: "assets/voiceover/launch-vo/hook-1.wav", display: "Son 23 pestañas.", spoken: "Son veintitrés pestañas." },
      { id: "fix-1", state: "generated", file: "assets/voiceover/launch-vo/fix-1.wav", display: "Frameshell las cierra.", spoken: "freim shel las cierra." },
    ]);
    expect(said).toEqual(["Son veintitrés pestañas.", "freim shel las cierra."]);
    const hook = result.lines[0]!;
    expect(hook.trimmed.head).toBeCloseTo(0.28, 2);
    expect(hook.duration).toBeCloseTo(3 * 0.4 - 0.1 + 0.02 + 0.03, 2);
    expect(takeMarkOf(readFileSync(take("hook-1")))).toMatchObject({ provider: "stand-in", voice: "tone", text: "Son veintitrés pestañas." });
    expect(result.imported.map((entry) => entry.asset)).toEqual(["assets/voiceover/launch-vo/hook-1.wav", "assets/voiceover/launch-vo/fix-1.wav"]);
  });

  it("writes takes the managed ffmpeg ingests, mark chunk and all", async () => {
    const { imported } = await generate({ lines: ["hook-1"] });
    const id = imported[0]!.job.id;
    const deadline = Date.now() + 90_000;
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await conn.request("job.list", { cwd: root })).jobs.find((entry) => entry.id === id);
    } while (job && job.state !== "done" && job.state !== "failed" && Date.now() < deadline);
    expect(job).toMatchObject({ state: "done", error: null });
  }, 120_000);

  it("reuses current takes, says only changed lines and copies a take whose line moved", async () => {
    await generate();
    const fixBytes = readFileSync(take("fix-1"));
    const again = await generate();
    expect(again.lines.map((line) => line.state)).toEqual(["cached", "cached"]);
    expect(again.imported).toEqual([]);
    expect(said).toHaveLength(2);

    // A new first line in Fix: the old fix-1 text becomes fix-2, the new text is said.
    writeFileSync(join(root, "scripts", "launch-vo.md"), script([...LINES.slice(0, 4), "Una línea nueva.", LINES[4]!]));
    const edited = await generate();
    expect(edited.lines.map((line) => [line.id, line.state])).toEqual([
      ["hook-1", "cached"],
      ["fix-1", "generated"],
      ["fix-2", "copied"],
    ]);
    expect(said).toEqual(["Son veintitrés pestañas.", "freim shel las cierra.", "Una línea nueva."]);
    expect(readFileSync(take("fix-2"))).toEqual(fixBytes);
  });

  it("generates only the lines asked for, and names the valid ids for an unknown one", async () => {
    const result = await generate({ lines: ["fix-1"] });
    expect(result.lines.map((line) => line.id)).toEqual(["fix-1"]);
    expect(existsSync(take("hook-1"))).toBe(false);
    await expect(generate({ lines: ["fix-9"] })).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("lines: hook-1, fix-1") });
  });

  it("replays a retried request from its idempotency key without saying anything again", async () => {
    const key = "voiceover-retry-0001";
    const first = await generate({}, { idempotencyKey: key });
    const replay = await generate({}, { idempotencyKey: key });
    expect(replay).toEqual(first);
    expect(said).toHaveLength(2);
  });

  it("never overwrites a take file it did not write", async () => {
    mkdirSync(join(root, "assets", "voiceover", "launch-vo"), { recursive: true });
    writeFileSync(take("hook-1"), "edited by hand");
    await expect(generate()).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "not a voiceover take", files: ["assets/voiceover/launch-vo/hook-1.wav"] }),
    });
    expect(readFileSync(take("hook-1"), "utf8")).toBe("edited by hand");
    expect(said).toEqual([]);
  });

  it("says a line repeated in one call once and copies the take to the others", async () => {
    writeFileSync(join(root, "scripts", "launch-vo.md"), script(["## Hook", "Hola a todos.", "## Fix", "Hola a todos.", "Hola a todos."]));
    const result = await generate();
    expect(result.lines.map((line) => line.state)).toEqual(["generated", "copied", "copied"]);
    expect(said).toEqual(["Hola a todos."]);
    expect(readFileSync(take("fix-2")).equals(readFileSync(take("hook-1")))).toBe(true);
    expect((await generate()).lines.map((line) => line.state)).toEqual(["cached", "cached", "cached"]);
  });

  it("treats a hand-made take whose file name differs in letter case as the person's file", async () => {
    mkdirSync(join(root, "assets", "voiceover", "launch-vo"), { recursive: true });
    writeFileSync(join(root, "assets", "voiceover", "launch-vo", "hook-1.WAV"), "edited by hand");
    await expect(generate()).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "not a voiceover take", files: ["assets/voiceover/launch-vo/hook-1.WAV"] }),
    });
    expect(said).toEqual([]);
  });

  it("refuses scripts without `voiceover: true`, unknown providers and unknown voices", async () => {
    writeFileSync(join(root, "scripts", "plain.md"), "## Intro\nHola.");
    await expect(generate({ script: "scripts/plain.md", provider: "stand-in" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(generate({ provider: "nobody" })).rejects.toMatchObject({ code: ErrorCode.SpeechProviderNotFound, data: { provider: "nobody", available: ["stand-in"] } });
    await expect(generate({ voice: "soprano" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("voices: tone, low") });
    writeFileSync(join(root, "scripts", "launch-vo.md"), script(LINES, []));
    await expect(generate()).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("available: stand-in") });
  });
});

describe("voiceover.generate with a paid plugin provider", () => {
  beforeEach(async () => {
    installLocalPlugin(root, SPEECH_PLUGIN, "speech-plugin");
    writeFileSync(join(root, "scripts", "launch-vo.md"), script(LINES, ["provider: paid-tone"]));
  });
  const calls = () => {
    const file = join(root, ".frameshell", "plugins", "node_modules", "speech-plugin", "calls.txt");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  };

  it("needs a trusted project", async () => {
    await expect(generate()).rejects.toMatchObject({ code: ErrorCode.ProjectNotTrusted });
  });

  it("generates nothing until the cost is confirmed with `yes`", async () => {
    await conn.request("project.trust", { cwd: root, decision: "trust" });
    const refused = generate();
    await expect(refused).rejects.toMatchObject({
      code: ErrorCode.ConfirmationRequired,
      data: { provider: "paid-tone", voice: "narrator", lines: ["hook-1", "fix-1"], cost: { amount: expect.closeTo(0.46, 5), currency: "USD" }, characters: 46 },
    });
    expect(calls()).toEqual([]);
    expect(existsSync(join(root, "assets", "voiceover"))).toBe(false);

    const result = await generate({ yes: true });
    expect(result.cost).toEqual({ amount: expect.closeTo(0.46, 5), currency: "USD" });
    expect(result.lines.map((line) => line.state)).toEqual(["generated", "generated"]);
    expect(result.lines[0]!.trimmed).toEqual({ head: 0.98, tail: 0.97 });
    expect(calls()).toHaveLength(2);
    // Cached takes cost nothing: no confirmation needed.
    expect((await generate()).cost).toBeNull();
  });

  it("keeps and imports the takes finished before the provider fails", async () => {
    await conn.request("project.trust", { cwd: root, decision: "trust" });
    writeFileSync(join(root, "scripts", "launch-vo.md"), script([...LINES, "## End", "Now explode."], ["provider: paid-tone"]));
    await expect(generate({ yes: true })).rejects.toMatchObject({
      code: ErrorCode.SpeechFailed,
      data: { provider: "paid-tone", line: "end-1", details: "the voice broke", written: ["assets/voiceover/launch-vo/hook-1.wav", "assets/voiceover/launch-vo/fix-1.wav"] },
    });
    expect(statSync(take("fix-1")).isFile()).toBe(true);
    const assets = await conn.request("asset.list", { cwd: root });
    expect(assets.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining(["assets/voiceover/launch-vo/fix-1.wav", "assets/voiceover/launch-vo/hook-1.wav"]));
  });
});

describe("voiceover.generate with a provider that fails outside synthesis", () => {
  it("reports voices() and estimate() failures, and mixed currencies, as SpeechFailed", async () => {
    const standIn = standInSpeechProvider();
    const noVoices: SpeechProvider = { ...standIn, id: "no-voices", voices: () => Promise.reject(new Error("voice list unreachable")) };
    const noEstimate: SpeechProvider = { ...standIn, id: "no-estimate", estimate: () => Promise.reject(new Error("pricing unreachable")) };
    let n = 0;
    const mixed: SpeechProvider = { ...standIn, id: "mixed", estimate: () => ({ cost: 1, currency: n++ % 2 === 0 ? "USD" : "EUR" }) };
    const local = await startDaemon({
      socketPath: uniqueSocketPath(),
      idleTimeoutMs: Number.POSITIVE_INFINITY,
      speechProviders: [noVoices, noEstimate, mixed],
      dirs: { dataDir: tempDir(), configDir: tempDir() },
      binaries: testBinaryManager(),
    });
    const client = await connectToDaemon(local.socketPath, { client: "test" });
    try {
      const dir = join(tempDir(), "fail");
      await client.request("project.init", { dir });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "vo.md"), script(LINES, []));
      const call = (provider: string) => client.request("voiceover.generate", { cwd: dir, script: "scripts/vo.md", provider });
      await expect(call("no-voices")).rejects.toMatchObject({ code: ErrorCode.SpeechFailed, data: { provider: "no-voices", line: null, details: "voice list unreachable" } });
      await expect(call("no-estimate")).rejects.toMatchObject({ code: ErrorCode.SpeechFailed, data: { provider: "no-estimate", line: null, details: "pricing unreachable" } });
      await expect(call("mixed")).rejects.toMatchObject({ code: ErrorCode.SpeechFailed, data: { provider: "mixed", line: null, details: expect.stringContaining("both USD and EUR") } });
    } finally {
      client.close();
      await local.close();
    }
  });
});
