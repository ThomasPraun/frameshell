import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BinaryManager } from "../src/index.js";

/**
 * Shared managed ffmpeg for media tests: downloaded once per machine (CI caches
 * it), never per test. `FRAMESHELL_TEST_BINARIES_DIR` overrides the location.
 */
export function testBinariesDir(): string {
  return (
    process.env["FRAMESHELL_TEST_BINARIES_DIR"] ||
    fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url))
  );
}

/** Manager over {@link testBinariesDir}; its config dir holds no `config.json`, so no override applies. */
export function testBinaryManager(): BinaryManager {
  const dir = testBinariesDir();
  return new BinaryManager({ dataDir: dir, configDir: dir });
}

/** Absolute paths of the managed ffmpeg and ffprobe, installing them first when missing. */
export async function mediaTools(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const binaries = testBinaryManager();
  return { ffmpeg: await binaries.ensure("ffmpeg"), ffprobe: await binaries.ensure("ffprobe") };
}

const execFileAsync = promisify(execFile);

/** Run a tool to completion; rejects with its stderr on a non-zero exit. */
export async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(file, args, { maxBuffer: 256 << 20, windowsHide: true, encoding: "utf8" });
  } catch (error) {
    throw new Error(`${file} ${args.join(" ")} failed:\n${String((error as { stderr?: unknown }).stderr ?? error)}`, { cause: error });
  }
}

/** Like {@link run} but returns stdout as bytes (raw frames, PCM). */
export async function runBuffer(file: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(file, args, { maxBuffer: 256 << 20, windowsHide: true, encoding: "buffer" });
    return stdout;
  } catch (error) {
    throw new Error(`${file} ${args.join(" ")} failed:\n${String((error as { stderr?: unknown }).stderr ?? error)}`, { cause: error });
  }
}
