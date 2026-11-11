import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Blender versions this plugin runs, in words (ADR 0035). */
export const SUPPORTED_BLENDER = "4.5 LTS and 5.x";

/**
 * True for the 4.5 LTS and every 5.x release. `BLENDER_PACKAGE.userInstall.supports` in
 * `packages/core/src/binaries/manifest.ts` repeats the rule for `doctor`; `test/blender.test.ts` checks they agree.
 */
export function supportedBlender(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major === 5 || (major === 4 && minor >= 5);
}

/** Version token of `blender --version` output (`Blender 4.5.3 LTS` → `4.5.3`), or null. */
export function parseBlenderVersion(output: string): string | null {
  return /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(output)?.[1] ?? null;
}

/** Absolute path of a script shipped in `python/`, which `src/` and `dist/` both sit beside. */
export function scriptPath(name: "render.py" | "deps.py"): string {
  return fileURLToPath(new URL(`../python/${name}`, import.meta.url));
}

/** Facts a run of the shipped scripts reports on a `FRAMESHELL <json>` line of Blender's output. */
export type BlenderEvent =
  | { event: "start"; frameStart: number; frames: number; engine: string }
  | { event: "frame"; index: number }
  | { event: "error"; code: string; [detail: string]: unknown };

/** Options for {@link runBlender}. */
export interface RunOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  /** Give up after this long; default none (a render has no cap, ADR 0035 decision 5). */
  timeoutMs?: number | undefined;
  onEvent?: ((event: BlenderEvent) => void) | undefined;
  /** Frame number of each `Fra:` line Blender prints while rendering. */
  onFrame?: ((frame: number) => void) | undefined;
}

/** What a finished run leaves. `error` is the shipped script's own refusal, when it printed one. */
export interface RunResult {
  error: Extract<BlenderEvent, { event: "error" }> | null;
  /** Last lines of output, for messages. */
  tail: string[];
}

/**
 * One-shot `blender -b --factory-startup -Y <blend> -P <script> -- <json>`: no add-ons or preferences of the
 * user's, scripts embedded in the .blend never auto-run, no socket (ADR 0035). Resolves with the run's result
 * when Blender exits 0 and printed no error; rejects otherwise. Kills Blender when `signal` aborts.
 */
export async function runBlender(blender: string, blend: string, script: string, request: unknown, options: RunOptions): Promise<RunResult> {
  const args = ["-b", "--factory-startup", "-Y", blend, "--python-exit-code", "1", "-P", script, "--", JSON.stringify(request)];
  const { signal } = options;
  signal?.throwIfAborted();
  const child = spawn(blender, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const tail: string[] = [];
  let error: RunResult["error"] = null;
  const line = (text: string) => {
    if (text === "") return;
    tail.push(text);
    if (tail.length > 40) tail.shift();
    if (text.startsWith("FRAMESHELL ")) {
      let event: BlenderEvent;
      try {
        event = JSON.parse(text.slice("FRAMESHELL ".length)) as BlenderEvent;
      } catch {
        return;
      }
      if (event.event === "error") error ??= event;
      options.onEvent?.(event);
      return;
    }
    const frame = /^Fra:(-?\d+)\b/.exec(text)?.[1];
    if (frame !== undefined) options.onFrame?.(Number(frame));
  };
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const text of lines) line(text);
    });
    stream.on("end", () => line(pending));
  }
  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    // A Blender that ignores SIGTERM would keep the GPU: escalate.
    killer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    killer.unref();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal?.throwIfAborted();
    if (timer && options.timeoutMs && code === null) throw new Error(`Blender did not finish within ${Math.round(options.timeoutMs / 1000)} s`);
    if (error) return { error, tail };
    if (code !== 0) throw new Error(`Blender exited with ${code === null ? "a signal" : `code ${code}`}:\n${tail.slice(-12).join("\n")}`);
    return { error: null, tail };
  } finally {
    signal?.removeEventListener("abort", stop);
    clearTimeout(timer);
    clearTimeout(killer);
  }
}

/** One cached probe of the executable at a path. */
interface Probed {
  size: number;
  mtimeMs: number;
  version: Promise<string>;
}

/**
 * Version of the user's Blender, asked with `--version` and remembered while the executable's size and mtime
 * stay the same: the key check calls it on every refresh, an upgrade is noticed at once.
 */
export class VersionProbe {
  readonly #known = new Map<string, Probed>();

  /** Supported version of the Blender at `path`; throws a message with the fix when it does not run or is out of range. */
  async version(path: string): Promise<string> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Blender not found at ${path}. Fix \`binaries.blender\`.`);
    let probed = this.#known.get(path);
    if (!probed || probed.size !== info.size || probed.mtimeMs !== info.mtimeMs) {
      probed = { size: info.size, mtimeMs: info.mtimeMs, version: ask(path) };
      this.#known.set(path, probed);
      probed.version.catch(() => this.#known.delete(path));
    }
    const version = await probed.version;
    if (!supportedBlender(version)) {
      throw new Error(
        `Blender ${version} at ${path} is outside the supported range (${SUPPORTED_BLENDER}). Install a supported Blender and point \`binaries.blender\` at it.`,
      );
    }
    return version;
  }
}

function ask(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 30_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) return reject(new Error(`Cannot run Blender at ${path}: ${error.message}`));
      const version = parseBlenderVersion(stdout);
      if (!version) return reject(new Error(`${path} --version printed no Blender version. Is it Blender?`));
      resolve(version);
    });
  });
}
