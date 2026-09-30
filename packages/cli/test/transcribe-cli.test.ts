import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryManager, type Daemon, startDaemon } from "@frameshell/core";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";
import { fakeWhisperCli, toneWav, whisperPluginFixture, whisperReadyBinaries, whisperSegment } from "../../core/test/whisper-fixture.js";

// Black-box: the built CLI against an in-process daemon whose whisper-cli is fake and whose audio extraction is canned.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const NPM_TIMEOUT = 120_000;

let daemon: Daemon;
let socketPath: string;
let dirs: { dataDir: string; configDir: string };
let project: string;

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

// The fake whisper-cli is a shebang script: unix only.
describe.skipIf(process.platform === "win32")("frameshell transcribe", () => {
  beforeAll(async () => {
    const cli = fakeWhisperCli({ transcription: [whisperSegment("Hola", 45), whisperSegment("mundo.", 155)] });
    socketPath = uniqueSocketPath();
    dirs = { dataDir: tempDir(), configDir: tempDir() };
    daemon = await startDaemon({
      socketPath,
      dirs,
      binaries: await whisperReadyBinaries(cli.path, (dirs) => new BinaryManager(dirs)),
      extractAudio: async (_input, output) => writeFileSync(output, toneWav(2.5, [[0.3, 0.8], [1.4, 1.9]])),
    });
    project = tempDir();
    expect((await frameshell(["init"], project)).code).toBe(0);
    writeFileSync(join(project, "assets", "raw-01.mp4"), "hello");
    const install = await frameshell(["plugin", "install", whisperPluginFixture().spec], project);
    expect(install.stderr).toBe("");
    expect(install.stdout).toContain("transcription providers: whisper-cpp");
  }, NPM_TIMEOUT);
  afterAll(async () => {
    await daemon?.close();
  });

  it("writes the transcript, prints a summary, and shows progress on stderr", async () => {
    const result = await frameshell(["transcribe", "raw-01.mp4", "--language", "es"], join(project, "assets"));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Transcribed assets\/raw-01\.mp4 -> transcripts\/raw-01\.words\.json\n/);
    expect(result.stdout).toMatch(/2 words · whisper-cpp large-v3-turbo-q5_0 · es · metal/);
    expect(result.stderr).toMatch(/Compiled Metal GPU shaders in 14\.6 s/);
    expect(result.stderr).toMatch(/Transcribing \(metal\) 100%/);
    const transcript = JSON.parse(readFileSync(join(project, "transcripts", "raw-01.words.json"), "utf8"));
    expect(transcript.words.map((w: { text: string }) => w.text)).toEqual(["Hola", "mundo."]);
  });

  it("--json prints the result only, with no progress noise", async () => {
    const result = await frameshell(["transcribe", "assets/raw-01.mp4", "--json"], project);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ transcript: "transcripts/raw-01.words.json", words: 2, reusedIds: 2 });
  });

  it("exits 1 with an actionable message for a missing asset", async () => {
    const result = await frameshell(["transcribe", "assets/nope.mp4"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nope\.mp4 does not exist/);
  });

  it("exits 2 on a usage error", async () => {
    const result = await frameshell(["transcribe"], project);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("transcribe <asset>");
  });

  describe("--verify", () => {
    /**
     * Source: "Hola mundo. cruel" (0.45, 1.55, 1.95 s). The timeline keeps
     * 0–2.2 s, cutting inside "cruel" (1.95–2.35, mostly kept). The fake
     * whisper hears only "Hola mundo." in the export: "cruel" is lost at the cut.
     */
    beforeAll(() => {
      writeFileSync(join(project, "exports.mp4"), "export");
      writeFileSync(
        join(project, "transcripts", "raw-01.words.json"),
        JSON.stringify({
          schemaVersion: 1,
          asset: "assets/raw-01.mp4",
          assetHash: `sha256:${createHash("sha256").update("hello").digest("hex")}`,
          provider: "whisper-cpp",
          model: "large-v3-turbo-q5_0",
          language: "es",
          words: [
            { id: "w_000001", text: "Hola", start: 0.45, end: 0.8 },
            { id: "w_000002", text: "mundo.", start: 1.55, end: 1.9 },
            { id: "w_000003", text: "cruel", start: 1.95, end: 2.35 },
          ],
          nextWordId: 4,
        }),
      );
      writeFileSync(
        join(project, "timelines", "main.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "main",
          // Direct edits keep the revision they were read at; the daemon bumps it (SPEC §6.4).
          revision: JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")).revision,
          tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_0001", type: "media", asset: "assets/raw-01.mp4", start: 0, in: 0, out: 2.2 }] }],
        }),
      );
    });

    it("prints the words lost at cuts with position and clip, and exits 1", async () => {
      const result = await frameshell(["transcribe", "--verify", "exports.mp4"], project);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/^Verified .*exports\.mp4 against timeline main \(revision 1\): 3 words expected, 2 heard/);
      expect(result.stdout).toMatch(/Lost at cuts \(1\):\n {2}1\.950 s {2}"cruel" {2}clip c_0001 \(track v1\) · out cut at 2\.200 s, clipped · w_000003/);
    });

    it("--json prints the report for agents", async () => {
      const result = await frameshell(["transcribe", "--verify", join(project, "exports.mp4"), "--timeline", "main", "--json"], project);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        timeline: "main",
        expected: 3,
        heard: 2,
        lost: [{ word: "w_000003", text: "cruel", clip: "c_0001", at: 1.95, cut: { edge: "out", at: 2.2 }, clipped: true }],
        uncertain: [],
      });
    });

    it("exits 2 when given an asset too", async () => {
      const result = await frameshell(["transcribe", "raw-01.mp4", "--verify", "exports.mp4"], project);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--verify <export>");
    });
  });
});
