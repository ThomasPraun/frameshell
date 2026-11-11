import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BinaryManager } from "@frameshell/core";
import type { InputsContext, RenderContext, RenderProgress } from "@frameshell/plugin-api";

const execFileAsync = promisify(execFile);

export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-blender-test-")));
}

/** What the stub's `config.json` takes; see `fixtures/stub-blender.mjs`. */
export interface StubConfig {
  version?: string;
  /** Exit 1 with a traceback while rendering the second frame. */
  crash?: boolean;
  /** Write one PNG fewer than asked. */
  skipLast?: boolean;
  /** Stay alive after this many frames, until killed. */
  hangAfter?: number;
}

/** Fake `blender` executable (a POSIX shell wrapper over `fixtures/stub-blender.mjs`), with its call log. */
export function stubBlender(config: StubConfig = {}) {
  const dir = tempDir();
  copyFileSync(fileURLToPath(new URL("./fixtures/stub-blender.mjs", import.meta.url)), join(dir, "stub.mjs"));
  const path = join(dir, "blender");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "stub.mjs")}" "$@"\n`);
  chmodSync(path, 0o755);
  const stub = {
    path,
    dir,
    configure(next: StubConfig) {
      writeFileSync(join(dir, "config.json"), JSON.stringify(next));
    },
    /** Arguments of every run so far, in order. */
    calls(): string[][] {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { argv: string[] }).argv);
      } catch {
        return [];
      }
    },
    /** Runs that listed files (`-P deps.py`) or rendered (`-P render.py`). */
    runs(script: "deps.py" | "render.py"): string[][] {
      return stub.calls().filter((argv) => argv.includes("-P") && argv[argv.indexOf("-P") + 1]!.endsWith(script));
    },
    /** Pid of the last render, to check it is gone. */
    pid(): number {
      return Number(readFileSync(join(dir, "pid"), "utf8"));
    },
  };
  stub.configure(config);
  return stub;
}

/** A "blend" the stub reads: Blender's magic bytes and a JSON model of the scene. */
export function writeBlend(project: string, rel: string, model: Record<string, unknown> = {}): string {
  const file = join(project, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `BLENDER${JSON.stringify(model)}`);
  return file;
}

/** Same store as the core media tests (`FRAMESHELL_TEST_BINARIES_DIR` overrides). */
export function managedBinaries(): BinaryManager {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
}

/** `ensureBinary` answering `blender` with `blender` and every other tool from the managed store. */
export function ensureWith(blender: string | (() => Promise<string>)): (name: string) => Promise<string> {
  const managed = managedBinaries();
  return async (name) => {
    if (name === "blender") return typeof blender === "string" ? blender : blender();
    return managed.ensure(name);
  };
}

export function inputsContext(project: string, blender: string): InputsContext {
  return { projectDir: project, ensureBinary: ensureWith(blender) };
}

/** Render context at a small format; `progress` collects the reports. */
export function renderContext(project: string, blender: string, overrides: Partial<RenderContext> = {}) {
  const outDir = join(tempDir(), "out");
  mkdirSync(outDir, { recursive: true });
  const progress: RenderProgress[] = [];
  const controller = new AbortController();
  const ctx: RenderContext = {
    projectDir: project,
    outDir,
    fps: 10,
    width: 64,
    height: 36,
    signal: controller.signal,
    ensureBinary: ensureWith(blender),
    progress: (update) => progress.push(update),
    ...overrides,
  };
  return { ctx, progress, controller };
}

/** Every frame of a VP9 WebM as RGBA, decoded with libvpx (the native decoder drops alpha: ADR 0002). */
export async function decodeRgba(file: string): Promise<Buffer> {
  const ffmpeg = await managedBinaries().ensure("ffmpeg");
  const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    encoding: "buffer",
    maxBuffer: 256 << 20,
  });
  return stdout;
}

/** Alpha of pixel (`x`, `y`) of `frame` in {@link decodeRgba} output of a `width` x `height` render. */
export function alphaAt(rgba: Buffer, size: { width: number; height: number }, frame: number, x: number, y: number): number {
  return rgba[((frame * size.height + y) * size.width + x) * 4 + 3]!;
}
