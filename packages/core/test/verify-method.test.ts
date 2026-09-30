import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type AudioInput, BinaryManager, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { fakeWhisperCli, toneWav, whisperPluginFixture, whisperReadyBinaries, whisperSegment } from "./whisper-fixture.js";

// Real daemon and official plugin, fake whisper-cli hearing the export, canned audio extraction.
const NPM_TIMEOUT = 120_000;

/** Every input the daemon extracted audio from. */
const extracted: AudioInput[] = [];

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

/**
 * Source take: "uno dos tres cuatro" at 0.5, 1.5, 2.5, 3.5 s. The timeline
 * keeps 0.3–2.75 s: its out point lands inside "tres" (2.5–2.9), which is
 * mostly kept, so a word is lost at that cut. The fake whisper hears only
 * "uno" and "dos" in the export (timeline 0.2 and 1.2 s).
 */
function writeProject(dir: string): void {
  writeFileSync(join(dir, "assets", "take.mp4"), "take");
  writeFileSync(join(dir, "exports-main.mp4"), "export");
  const words = [
    ["uno", 0.5, 0.9],
    ["dos", 1.5, 1.9],
    ["tres", 2.5, 2.9],
    ["cuatro", 3.5, 3.9],
  ] as const;
  writeFileSync(
    join(dir, "transcripts", "take.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset: "assets/take.mp4",
      assetHash: `sha256:${createHash("sha256").update("take").digest("hex")}`,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      language: "es",
      words: words.map(([text, start, end], i) => ({ id: `w_00000${i + 1}`, text, start, end })),
      edits: {},
      nextWordId: 5,
    }),
  );
  writeFileSync(
    join(dir, "timelines", "main.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "main",
      revision: 3,
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_0001", type: "media", asset: "assets/take.mp4", start: 0, in: 0.3, out: 2.75 }] }],
    }),
  );
}

// The fake whisper-cli is a shebang script: unix only.
describe.skipIf(process.platform === "win32")("transcribe.verify method", () => {
  beforeAll(async () => {
    const cli = fakeWhisperCli({ result: { language: "es" }, transcription: [whisperSegment("Uno,", 20), whisperSegment("dos.", 120)] });
    daemon = await startDaemon({
      socketPath: uniqueSocketPath(),
      dirs: { dataDir: tempDir(), configDir: tempDir() },
      binaries: await whisperReadyBinaries(cli.path, (dirs) => new BinaryManager(dirs)),
      extractAudio: async (input, output) => {
        extracted.push(input);
        writeFileSync(output, toneWav(2.45, [[0.2, 0.6], [1.2, 1.6]]));
      },
    });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    await conn.request("plugin.install", { cwd: project, spec: whisperPluginFixture().spec });
    writeProject(project);
  }, NPM_TIMEOUT);
  afterAll(async () => {
    conn?.close();
    await daemon?.close();
  });

  it("re-transcribes the export and reports the word lost at the cut", async () => {
    const result = await conn.request("transcribe.verify", { cwd: project, export: "exports-main.mp4" });

    expect(methods["transcribe.verify"].result.parse(result)).toEqual(result);
    expect(extracted.at(-1)).toEqual({ path: join(project, "exports-main.mp4") });
    expect(result).toMatchObject({
      export: join(project, "exports-main.mp4"),
      timeline: "main",
      revision: 3,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      language: "es",
      expected: 3,
      heard: 2,
      lost: [{ word: "w_000003", text: "tres", clip: "c_0001", track: "v1", at: 2.2, cut: { edge: "out", at: 2.45 }, clipped: true }],
      uncertain: [],
      unchecked: [],
      warnings: [],
    });
    expect(readdirSync(join(project, "transcripts"))).toEqual(["take.words.json"]);
  });

  it("fails with AssetNotFound for a missing export", async () => {
    await expect(conn.request("transcribe.verify", { cwd: project, export: "nope.mp4" })).rejects.toMatchObject({
      code: ErrorCode.AssetNotFound,
    });
  });

  it("fails with TimelineNotFound for an unknown timeline", async () => {
    await expect(
      conn.request("transcribe.verify", { cwd: project, export: "exports-main.mp4", timeline: "intro" }),
    ).rejects.toMatchObject({ code: ErrorCode.TimelineNotFound });
  });
});
