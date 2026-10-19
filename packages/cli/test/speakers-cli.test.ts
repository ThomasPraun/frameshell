import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryManager, DIARIZATION_TOOL, type Daemon, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL, startDaemon } from "@frameshell/core";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";

// Black-box: the built CLI against an in-process daemon with a stand-in diarizer and fake model files.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
/** sha256("hello"). */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

let daemon: Daemon;
let socketPath: string;
let dirs: { dataDir: string; configDir: string };
let project: string;
const counts: (number | undefined)[] = [];

/** Async on purpose: a sync spawn would block the in-process daemon the child talks to. */
function frameshell(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd,
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
  socketPath = uniqueSocketPath();
  dirs = { dataDir: tempDir(), configDir: tempDir() };
  const engine = join(tempDir(), DIARIZATION_TOOL);
  writeFileSync(engine, "");
  writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ binaries: { [DIARIZATION_TOOL]: engine } }));
  const binaries = new BinaryManager(dirs);
  for (const id of [SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL]) {
    const model = await binaries.locateModel(id);
    mkdirSync(join(model.path, ".."), { recursive: true });
    writeFileSync(model.path, "fake model");
  }
  daemon = await startDaemon({
    socketPath,
    dirs,
    binaries,
    extractAudio: async (_input, output) => writeFileSync(output, "wav"),
    diarize: async ({ speakers, onProgress }) => {
      counts.push(speakers);
      onProgress(0.5);
      return [
        { start: 0, end: 1, label: "speaker_00" },
        { start: 1, end: 2, label: "speaker_01" },
      ];
    },
  });
  project = tempDir();
  expect((await frameshell(["init", "--no-skill"], project)).code).toBe(0);
  writeFileSync(join(project, "assets", "talk.mp4"), "hello");
  writeFileSync(
    join(project, "transcripts", "talk.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset: "assets/talk.mp4",
      assetHash: `sha256:${HELLO_SHA256}`,
      provider: "whisper-cpp",
      model: "m",
      words: [
        { id: "w_000001", text: "Hola", start: 0.2, end: 0.6 },
        { id: "w_000002", text: "hola", start: 1.2, end: 1.6 },
      ],
      edits: {},
    }),
  );
});
afterAll(async () => {
  await daemon?.close();
});

describe("frameshell transcribe --speakers", () => {
  it("finds the speakers, prints who says how much, shows progress on stderr, and passes --people", async () => {
    const result = await frameshell(["transcribe", "--speakers", "talk.mp4", "--people", "2"], join(project, "assets"));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Speakers of assets/talk.mp4 -> transcripts/talk.words.json");
    expect(result.stdout).toMatch(/s1 {2}Speaker 1 {2}1 words/);
    expect(result.stderr).toContain("Finding who speaks in assets/talk.mp4");
    expect(counts.at(-1)).toBe(2);
    const written = JSON.parse(readFileSync(join(project, "transcripts", "talk.words.json"), "utf8"));
    expect(written.words.map((word: { speaker: string }) => word.speaker)).toEqual(["s1", "s2"]);
  });

  it("--json prints the result only", async () => {
    const result = await frameshell(["transcribe", "--speakers", "assets/talk.mp4", "--json"], project);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ speakers: [{ id: "s1" }, { id: "s2" }], segments: 2 });
    expect(result.stderr).toBe("");
  });

  it("exits 2 on --people without --speakers, a bad count, or a stray asset", async () => {
    expect((await frameshell(["transcribe", "assets/talk.mp4", "--people", "2"], project)).code).toBe(2);
    expect((await frameshell(["transcribe", "--speakers", "assets/talk.mp4", "--people", "two"], project)).code).toBe(2);
    expect((await frameshell(["transcribe", "--speakers", "assets/talk.mp4", "assets/other.mp4"], project)).code).toBe(2);
  });
});
