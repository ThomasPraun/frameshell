import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AssetInfo, type DaemonConnection, ErrorCode, type Progress, connectToDaemon, methods } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, type AudioInput, BinaryManager, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { type GitPlugin, gitPluginFixture } from "./plugin-fixture.js";
import { fakeWhisperCli, toneWav, whisperPluginFixture, whisperReadyBinaries, whisperSegment } from "./whisper-fixture.js";

// Real daemon, real official plugin installed with npm from a local git repo, fake whisper-cli.
const NPM_TIMEOUT = 120_000;

/** "Hola" sounds 0.30–0.80 s, "mundo" 1.40–1.90 s. */
const extractTone: AudioExtractor = async (input, output) => {
  extracted.push(input);
  writeFileSync(output, toneWav(2.5, [[0.3, 0.8], [1.4, 1.9]]));
};
/** Every input the daemon asked to extract audio from. */
const extracted: AudioInput[] = [];

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
      // Stage codes cross the wire beside the English message, for the app to translate.
      const stages = progress.flatMap((p) => (p.stage ? [p.stage] : []));
      expect(stages).toEqual(expect.arrayContaining(["hash", "binary", "model", "model-load", "gpu-compiled", "transcribe"]));
      expect(progress.find((p) => p.stage === "model")?.values).toEqual({ model: "large-v3-turbo-q5_0" });
      expect(progress.find((p) => p.stage === "transcribe")?.values).toEqual({ device: "metal" });
      const args = cli.args();
      expect(args).toEqual(expect.arrayContaining(["-dtw", "large.v3.turbo", "-nfa", "-sow", "-ojf"]));
      expect(args[args.indexOf("-m") + 1]).toMatch(/ggml-large-v3-turbo-q5_0\.bin$/);
    },
    NPM_TIMEOUT,
  );

  it(
    "takes the audio from the PCM sidecar that importing the asset produced",
    async () => {
      const dir = tempDir();
      await conn.request("project.init", { dir });
      await conn.request("plugin.install", { cwd: dir, spec: whisper.spec });
      const source = join(tempDir(), "take.mp4");
      await makeClip(source, { durationS: 2.5 });
      const { imported } = await conn.request("asset.import", { cwd: dir, files: [source] });
      const deadline = Date.now() + 90_000;
      let asset: AssetInfo | undefined;
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        ({ assets: [asset] } = await conn.request("asset.list", { cwd: dir }));
      } while (asset?.state !== "ready" && asset?.state !== "failed" && Date.now() < deadline);
      expect(asset).toMatchObject({ path: imported[0]!.asset, state: "ready", sidecar: { format: "s16le", sampleRate: 48_000 } });

      const from = extracted.length;
      const result = await conn.request("transcribe", { cwd: dir, asset: "assets/take.mp4" });
      expect(result.audioSource).toBe(asset!.sidecar!.path);
      expect(result.assetHash).toBe(asset!.hash);
      expect(extracted.slice(from)).toEqual([
        { path: join(dir, ...asset!.sidecar!.path.split("/")), raw: { format: "s16le", sampleRate: 48_000, channels: 1 } },
      ]);
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

  it(
    "transcribes with a model file registered on this machine, named by id in frameshell.json, its hash in the transcript",
    async () => {
      const dir = await projectWithAsset();
      await conn.request("plugin.install", { cwd: dir, spec: whisper.spec });
      const file = join(tempDir(), "ggml-es-small.bin");
      writeFileSync(file, "lmggfake weights");
      const added = await conn.request("model.add", { id: "es-small", file, options: { dtw: "small" } });
      expect(methods["model.add"].result.parse(added)).toEqual(added);
      expect(added.model).toMatchObject({ id: "es-small", format: "ggml", state: "ok" });

      const set = await conn.request("transcription.set", { cwd: dir, model: "es-small" });
      expect(set).toEqual({ provider: "whisper-cpp", model: "es-small", previous: null });
      expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8")).transcription).toEqual({ provider: "whisper-cpp", model: "es-small" });

      const result = await conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" });
      expect(result).toMatchObject({ model: "es-small", modelHash: `sha256:${added.model.sha256}`, warnings: [] });
      const args = cli.args();
      expect(args[args.indexOf("-m") + 1]).toBe(file);
      expect(args[args.indexOf("-dtw") + 1]).toBe("small");
      const transcript = JSON.parse(readFileSync(join(dir, "transcripts", "raw-01.words.json"), "utf8"));
      expect(transcript).toMatchObject({ model: "es-small", modelHash: `sha256:${added.model.sha256}` });

      const listed = await conn.request("model.list", { cwd: dir });
      expect(methods["model.list"].result.parse(listed)).toEqual(listed);
      expect(listed.models.map((m) => m.id)).toContain("es-small");
      expect(listed.providers).toEqual([
        expect.objectContaining({ id: "whisper-cpp", defaultModel: "large-v3-turbo-q5_0", userModels: { formats: ["ggml"], options: [expect.objectContaining({ key: "dtw" })] }, models: expect.arrayContaining([{ id: "large-v3-turbo-q5_0", size: expect.any(Number), downloaded: true }]) }),
      ]);
      expect(listed.project).toEqual({ dir, provider: "whisper-cpp", model: "es-small", effective: "es-small" });

      await conn.request("model.remove", { id: "es-small" });
      await expect(conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" })).rejects.toMatchObject({
        code: ErrorCode.ModelNotRegistered,
        message: expect.stringContaining("frameshell model add es-small <file>"),
      });
    },
    NPM_TIMEOUT,
  );

  it(
    "uses this machine's default model when the project names none, and checks ids against the provider's models",
    async () => {
      const dir = await projectWithAsset();
      await conn.request("plugin.install", { cwd: dir, spec: whisper.spec });
      expect(await conn.request("model.default", { provider: "whisper-cpp", model: "large-v3-turbo-q8_0", cwd: dir })).toMatchObject({ previous: null });
      await expect(conn.request("model.default", { provider: "whisper-cpp", model: "tiny", cwd: dir })).rejects.toMatchObject({
        code: ErrorCode.ModelNotRegistered,
      });
      await expect(conn.request("transcription.set", { cwd: dir, model: "tiny" })).rejects.toMatchObject({ code: ErrorCode.ModelNotRegistered });
      const listed = await conn.request("model.list", { cwd: dir });
      expect(listed.project).toMatchObject({ model: null, effective: "large-v3-turbo-q8_0" });
      const file = join(tempDir(), "ggml-mine.bin");
      writeFileSync(file, "lmggmine");
      await conn.request("model.add", { id: "mine", file });
      await conn.request("model.default", { provider: "whisper-cpp", model: "mine" });
      const result = await conn.request("transcribe", { cwd: dir, asset: "assets/raw-01.mp4" });
      expect(result.model).toBe("mine");
      expect(result.warnings).toEqual([expect.stringMatching(/"mine" has no DTW preset/)]);
      const args = cli.args();
      expect(args[args.indexOf("-m") + 1]).toBe(file);
      expect(args).not.toContain("-dtw");
      await conn.request("model.remove", { id: "mine" });
      expect((await conn.request("model.list", {})).defaults).toEqual({});
    },
    NPM_TIMEOUT,
  );
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
