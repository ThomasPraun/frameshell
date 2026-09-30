import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type Progress, connectToDaemon, methods } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, BinaryManager, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { type GitPlugin, gitPluginFixture } from "./plugin-fixture.js";
import { fakeWhisperCli, toneWav, whisperPluginFixture, whisperReadyBinaries, whisperSegment } from "./whisper-fixture.js";

// Real daemon, real official plugin installed with npm from a local git repo, fake whisper-cli.
const NPM_TIMEOUT = 120_000;

/** "Hola" sounds 0.30–0.80 s, "mundo" 1.40–1.90 s. */
const extractTone: AudioExtractor = async (_input, output) => writeFileSync(output, toneWav(2.5, [[0.3, 0.8], [1.4, 1.9]]));

let daemon: Daemon;
let conn: DaemonConnection;
let whisper: GitPlugin;
let cli: ReturnType<typeof fakeWhisperCli>;

beforeAll(async () => {
  whisper = whisperPluginFixture();
  cli = fakeWhisperCli({ result: { language: "es" }, transcription: [whisperSegment("Hola", 45), whisperSegment("mundo.", 155)] });
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: await whisperReadyBinaries(cli.path, (dirs) => new BinaryManager(dirs)),
    extractAudio: extractTone,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
});
afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function projectWithAsset(): Promise<string> {
  const dir = tempDir();
  await conn.request("project.init", { dir });
  writeFileSync(join(dir, "assets", "raw-01.mp4"), "hello");
  return dir;
}

// The fake whisper-cli is a shebang script: unix only.
describe.skipIf(process.platform === "win32")("transcribe method with @frameshell/whisper-cpp", () => {
  it(
    "transcribes through the installed plugin, streams progress, and writes the core transcript",
    async () => {
      const dir = await projectWithAsset();
      await conn.request("plugin.install", { cwd: dir, spec: whisper.spec });

      const progress: Progress[] = [];
      const result = await conn.request(
        "transcribe",
        { cwd: join(dir, "assets"), asset: "raw-01.mp4", language: "es" },
        { onProgress: (p) => progress.push(p) },
      );

      expect(methods.transcribe.result.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        transcript: "transcripts/raw-01.words.json",
        provider: "whisper-cpp",
        model: "large-v3-turbo-q5_0",
        language: "es",
        device: "metal",
        words: 2,
      });
      const transcript = JSON.parse(readFileSync(join(dir, "transcripts", "raw-01.words.json"), "utf8"));
      expect(parseTranscript(transcript).ok).toBe(true);
      expect(transcript.words.map((w: { id: string; text: string; start: number }) => [w.id, w.text, w.start])).toEqual([
        ["w_000001", "Hola", 0.45],
        ["w_000002", "mundo.", 1.55],
      ]);
      // Energy-derived end: the tone stops at 0.80 s.
      expect(transcript.words[0].end).toBeGreaterThanOrEqual(0.8);
      expect(transcript.words[0].end).toBeLessThanOrEqual(0.82);
      expect(progress.map((p) => p.message)).toEqual(
        expect.arrayContaining([expect.stringMatching(/Metal GPU shaders/), expect.stringMatching(/^Transcribing/)]),
      );
      const args = cli.args();
      expect(args).toEqual(expect.arrayContaining(["-dtw", "large.v3.turbo", "-nfa", "-sow", "-ojf"]));
      expect(args[args.indexOf("-m") + 1]).toMatch(/ggml-large-v3-turbo-q5_0\.bin$/);
    },
    NPM_TIMEOUT,
  );

  it("uses transcription settings from frameshell.json", async () => {
    const dir = await projectWithAsset();
    await conn.request("plugin.install", { cwd: dir, spec: whisper.spec });
    const configPath = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, transcription: { provider: "whisper-cpp", language: "en" } }));
    await conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" });
    const args = cli.args();
    expect(args[args.indexOf("-l") + 1]).toBe("en");
  }, NPM_TIMEOUT);
});

describe("transcribe method errors", () => {
  it("names how to install the default provider when no plugin provides it", async () => {
    const dir = await projectWithAsset();
    await expect(conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" })).rejects.toMatchObject({
      code: ErrorCode.TranscriptionProviderNotFound,
      message: expect.stringContaining("frameshell plugin install @frameshell/whisper-cpp"),
      data: { provider: "whisper-cpp", available: [] },
    });
  });

  it(
    "refuses while the project's plugins are not trusted",
    async () => {
      const dir = await projectWithAsset();
      const hello = gitPluginFixture();
      await conn.request("plugin.install", { cwd: dir, spec: hello.spec });
      await conn.request("project.trust", { cwd: dir, decision: "deny" });
      await expect(conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" })).rejects.toMatchObject({
        code: ErrorCode.ProjectNotTrusted,
      });
    },
    NPM_TIMEOUT,
  );

  it("reports a missing asset", async () => {
    const dir = await projectWithAsset();
    mkdirSync(join(dir, "transcripts"), { recursive: true });
    await expect(conn.request("transcribe", { cwd: dir, asset: "assets/nope.mp4" })).rejects.toMatchObject({
      code: ErrorCode.AssetNotFound,
    });
  });

  it("fails outside a project", async () => {
    await expect(conn.request("transcribe", { cwd: tempDir(), asset: "x.mp4" })).rejects.toMatchObject({
      code: ErrorCode.ProjectNotFound,
    });
  });
});
