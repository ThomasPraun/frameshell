import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

const MEDIA_TIMEOUT = 120_000;

let daemon: Daemon;
let conn: DaemonConnection;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("project.init like (#197)", () => {
  it(
    "takes the format of the given media file",
    async () => {
      const { ffmpeg } = await mediaTools();
      const source = join(tempDir(), "portrait.mp4");
      await run(ffmpeg, [
        ...["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=25", "-f", "lavfi", "-i", "sine=sample_rate=44100"],
        ...["-t", "0.5", "-c:v", "libx264", "-c:a", "aac", "-shortest", source],
      ]);
      const dir = join(tempDir(), "talk");
      await conn.request("project.init", { dir, like: source });
      const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));
      expect(config).toMatchObject({ resolution: { width: 720, height: 1280 }, fps: 25, sampleRate: 44100 });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "takes only the sample rate from an audio file, plus the size given",
    async () => {
      const { ffmpeg } = await mediaTools();
      const source = join(tempDir(), "podcast.mp3");
      await run(ffmpeg, [...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=sample_rate=44100", "-t", "0.5"], source]);
      const dir = join(tempDir(), "podcast");
      await conn.request("project.init", { dir, like: source, resolution: { width: 1080, height: 1920 } });
      const config = JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"));
      expect(config).toMatchObject({ resolution: { width: 1080, height: 1920 }, fps: 30, sampleRate: 44100 });
      const landscape = join(tempDir(), "podcast-wide");
      await conn.request("project.init", { dir: landscape, like: source });
      expect(JSON.parse(readFileSync(join(landscape, "frameshell.json"), "utf8"))).toMatchObject({
        resolution: { width: 1920, height: 1080 },
        sampleRate: 44100,
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a file that is not media and creates nothing",
    async () => {
      const notes = join(tempDir(), "notes.mp4");
      writeFileSync(notes, "not a video");
      const dir = join(tempDir(), "talk");
      await expect(conn.request("project.init", { dir, like: notes })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
      expect(() => readFileSync(join(dir, "frameshell.json"))).toThrow();
    },
    MEDIA_TIMEOUT,
  );
});
