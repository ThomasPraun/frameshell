import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, type ShootStatusResult, connectToDaemon } from "@frameshell/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryManager, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run } from "./media-tools.js";
import { fakeWhisperCli, whisperPluginFixture, whisperReadyBinaries, whisperSegment } from "./whisper-fixture.js";

// Seam under test (#411): a project without its transcription provider, through a real daemon, the managed ffmpeg,
// the official plugin installed with npm from a local git repo and a fake whisper-cli.

const SCRIPT_PATH = "scripts/launch.md";
const SESSION = "20261107-101500";
const MIC = `assets/shoot/${SESSION}/mic.m4a`;
const NPM_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;

beforeAll(async () => {
  const cli = fakeWhisperCli({ result: { language: "es" }, transcription: [whisperSegment("Hola", 45), whisperSegment("mundo.", 155)] });
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: await whisperReadyBinaries(cli.path, (dirs) => new BinaryManager(dirs)),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
}, 120_000);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function settled(root: string, take: string): Promise<ShootStatusResult["takes"][number]> {
  for (let i = 0; i < 300; i++) {
    const status = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
    const info = status.takes.find((candidate) => candidate.id === take)!;
    if (info.state !== "transcribing") return info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`take ${take} never settled`);
}

// The fake whisper-cli is a shebang script: unix only.
describe.skipIf(process.platform === "win32")("shoot in a project without a transcription provider", () => {
  it(
    "says so before recording, fails the take with why, and analyzes it once the provider is installed",
    async () => {
      const root = join(tempDir(), "launch");
      await conn.request("project.init", { dir: root });
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "assets", "shoot", SESSION), { recursive: true });
      writeFileSync(join(root, SCRIPT_PATH), ["---", "shoot: true", "---", "## Hook", "Hola mundo"].join("\n"));
      const { ffmpeg } = await mediaTools();
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=6", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", join(root, `${MIC}.part`)]);

      const before = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
      expect(before.transcription).toEqual({ provider: "whisper-cpp", ready: false, problem: expect.stringContaining("frameshell plugin install @frameshell/whisper-cpp") });

      const cut = await conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "hook", session: SESSION, start: 1, end: 3, sounds: [{ asset: MIC, offset: 0 }] });
      expect(await settled(root, cut.take.id)).toMatchObject({ state: "no-transcript", problem: expect.stringContaining('No transcription provider "whisper-cpp"') });

      await conn.request("plugin.install", { cwd: root, spec: whisperPluginFixture().spec });
      expect((await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH })).transcription).toEqual({ provider: "whisper-cpp", ready: true, problem: null });
      expect(await settled(root, cut.take.id)).toMatchObject({ state: "analyzed", scenes: ["hook"] });
    },
    NPM_TIMEOUT,
  );
});
