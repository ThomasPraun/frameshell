// Where the spike keeps downloads and WAVs (outside the repo: never commit weights or media) and where the
// built repo packages are. Run `pnpm build` at the repo root first.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SPIKE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REPO_ROOT = resolve(SPIKE_ROOT, "../..");

/** Downloads + generated WAVs. Delete it when done: `node src/clean.ts`. */
export const WORK_DIR = process.env.KOKORO_SPIKE_DIR ?? join(tmpdir(), "frameshell-kokoro-spike");
export const DOWNLOADS = join(WORK_DIR, "downloads");
export const OUT = join(WORK_DIR, "out");

/** Managed binaries cache shared with the repo's media tests (ffmpeg, onnxruntime-web). */
export const TEST_BINARIES =
  process.env.FRAMESHELL_TEST_BINARIES_DIR ?? join(REPO_ROOT, ".cache", "test-binaries");

/** ONNX Runtime Web as the binary manager installs it (pin 1.30.0, docs/binaries.md). */
export const ORT_RUNTIME = join(TEST_BINARIES, "binaries", "onnxruntime-web", "1.30.0", `${process.platform}-${process.arch}`, "onnxruntime-web.mjs");

/** A built repo module, by path from the repo root (`packages/core/dist/onnx-web.js`). */
export async function built<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(join(REPO_ROOT, path)).href)) as T;
}
