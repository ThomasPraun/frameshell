import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BinaryManager } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { type GitPlugin, commitFixture } from "./plugin-fixture.js";

const PLUGIN_DIR = fileURLToPath(new URL("../../../plugins/whisper-cpp/", import.meta.url));

/**
 * The built official `@frameshell/whisper-cpp` plugin (`tsc -b` first) as a
 * local git repo, installable like any published plugin.
 */
export function whisperPluginFixture(): GitPlugin {
  const dir = join(tempDir(), "whisper-cpp");
  mkdirSync(dir);
  for (const entry of ["frameshell-plugin.json", "dist", "skills"]) cpSync(join(PLUGIN_DIR, entry), join(dir, entry), { recursive: true });
  // Workspace-only dev dependency: npm cannot resolve `workspace:*`.
  const { devDependencies: _dev, ...pkg } = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return commitFixture(dir);
}

/**
 * Fake `whisper-cli` (unix only: a node script with a shebang). Logs like the
 * real one on stderr (Metal shader compile, backend, `-pp` progress), writes
 * `json` to `<-of>.json` and records its arguments to `<dir>/args.json`.
 */
export function fakeWhisperCli(json: unknown): { path: string; args: () => string[] } {
  const dir = tempDir();
  const path = join(dir, "whisper-cli");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
if (args.includes("--version")) { console.log("whisper.cpp version: 1.9.4-fake"); process.exit(0); }
console.error("ggml_metal_library_init: using embedded metal library");
console.error("ggml_metal_library_compile_all: loaded 20 libraries from embedded data in 14.639 sec (max single = 14.639 sec)");
console.error("whisper_backend_init_gpu: using MTL0 backend");
console.error("whisper_print_progress_callback: progress = 100%");
fs.writeFileSync(args[args.indexOf("-of") + 1] + ".json", ${JSON.stringify(JSON.stringify(json))});
`,
  );
  chmodSync(path, 0o755);
  return { path, args: () => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[] };
}

/**
 * Binary manager whose whisper-cli is `whisperCli` (global override) and whose
 * default model is already "downloaded". `create` builds it, so callers using
 * the built `@frameshell/core` pass their own class.
 */
export async function whisperReadyBinaries<T extends Pick<BinaryManager, "locateModel">>(
  whisperCli: string,
  create: (dirs: { dataDir: string; configDir: string }) => T,
): Promise<T> {
  const dirs = { dataDir: tempDir(), configDir: tempDir() };
  writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ binaries: { "whisper-cli": whisperCli } }));
  const binaries = create(dirs);
  const model = await binaries.locateModel("ggml-large-v3-turbo-q5_0");
  mkdirSync(join(model.path, ".."), { recursive: true });
  writeFileSync(model.path, "fake model");
  return binaries;
}

/** One `-ml 1 -sow -ojf` segment: a word with its DTW onset in centiseconds. */
export function whisperSegment(text: string, dtwCs: number) {
  return { text: ` ${text}`, offsets: { from: dtwCs * 10, to: dtwCs * 10 + 300 }, tokens: [{ text: ` ${text}`, p: 0.9, t_dtw: dtwCs }] };
}

/** Mono 16-bit 16 kHz WAV: 220 Hz tone at -6 dBFS inside `bursts` (seconds), silence elsewhere. */
export function toneWav(duration: number, bursts: readonly [number, number][]): Buffer {
  const rate = 16_000;
  const samples = new Int16Array(Math.round(duration * rate));
  for (const [from, to] of bursts) {
    for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) samples[i] = Math.round(16_000 * Math.sin((2 * Math.PI * 220 * i) / rate));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}
