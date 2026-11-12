// The machine-level `command` speech provider (ADR 0034): runs a TTS program the person installed and named in
// `<configDir>/config.json` under `speech.command`. It is accepted from there only: `frameshell.json` is strict
// and has no such key, so a downloaded project can never make Frameshell run a command. The project still picks
// the provider, the voice and the text, so those reach the program as data: text on stdin, voice and language as
// single arguments that may not start with `-`.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpeechProvider, SpeechVoice } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { GLOBAL_CONFIG_FILE, type SpeechCommandConfig, readGlobalConfig } from "../global-config.js";

/** Id of {@link commandSpeechProvider}. */
export const COMMAND_SPEECH_PROVIDER = "command";

const DEFAULT_TIMEOUT_S = 120;
/** Most of the program's stderr kept for the error message. */
const STDERR_TAIL = 2000;
/** Largest WAV accepted on stdout: 10 minutes of 48 kHz mono 16-bit is about 58 MB. */
const MAX_STDOUT = 256 * 1024 * 1024;

/**
 * The `command` provider for `config`, or null when `speech.command` is not in `<configDir>/config.json`.
 * Read on every call, so an edit of the file applies without restarting the daemon.
 * Throws `InvalidGlobalConfig` when the file is invalid.
 */
export async function readCommandSpeechProvider(configDir: string): Promise<SpeechProvider | null> {
  const { speech } = await readGlobalConfig(configDir);
  return speech?.command ? commandSpeechProvider(speech.command, configDir) : null;
}

/**
 * Speech provider that runs `config.run` (program and arguments, no shell) once per line with the spoken text on
 * stdin. `{voice}`, `{language}` and `{out}` in an argument are replaced; the program writes a mono 16-bit PCM WAV
 * to `{out}`, or to stdout when no argument has `{out}`. A relative program path (one with a separator) resolves
 * against `configDir`; a bare name is found on `PATH`. Free: it declares `free: true`.
 */
export function commandSpeechProvider(config: SpeechCommandConfig, configDir: string): SpeechProvider {
  const voices: SpeechVoice[] = (config.voices ?? []).map((voice) =>
    typeof voice === "string" ? { id: voice } : { id: voice.id, ...(voice.label ? { label: voice.label } : {}), ...(voice.languages ? { languages: voice.languages } : {}) },
  );
  const usesOut = config.run.some((arg) => arg.includes("{out}"));
  const program = /[\\/]/.test(config.run[0]!) ? resolve(configDir, config.run[0]!) : config.run[0]!;
  return {
    id: COMMAND_SPEECH_PROVIDER,
    version: config.version ?? "1",
    free: true,
    ...(config.defaultVoice ? { defaultVoice: config.defaultVoice } : {}),
    voices: () => voices,
    async synthesize(text, voice, options, context) {
      const language = options.language ?? "";
      for (const [name, value] of [["voice", voice], ["language", language]] as const) {
        if (value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error(`${name} "${value}" is not accepted: it starts with "-" or holds a control character`);
      }
      if (!language && config.run.some((arg) => arg.includes("{language}"))) {
        throw new Error("the command uses {language} but the script has no `language:` in its frontmatter");
      }
      const file = join(context.outDir, "take.wav");
      const args = config.run.slice(1).map((arg) => arg.replaceAll("{voice}", voice).replaceAll("{language}", language).replaceAll("{out}", file));
      const stdout = await run(program, args, text, context.outDir, (config.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000, context.signal, !usesOut, configDir);
      if (!usesOut) await writeFile(file, stdout);
      return { file, model: "command" };
    },
  };
}

/** Run one program to completion; the stdout bytes when `keepStdout`. Rejects with a message naming what went wrong. */
function run(program: string, args: string[], input: string, cwd: string, timeoutMs: number, signal: AbortSignal, keepStdout: boolean, configDir: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error(`${program} took longer than ${timeoutMs / 1000} s and was stopped (\`timeoutSeconds\` in ${join(configDir, GLOBAL_CONFIG_FILE)})`);
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (!keepStdout) return;
      if (outBytes > MAX_STDOUT) {
        failure ??= new Error(`${program} wrote more than ${MAX_STDOUT / 1024 / 1024} MB to stdout`);
        child.kill();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {
      // The program closed its input before reading all of it; its exit code says why.
    });
    child.stdin.end(input);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.name === "AbortError") return reject(new Error("stopped: the daemon is shutting down"));
      reject(
        new Error(
          error.code === "ENOENT"
            ? `could not start ${program}: not found. Check \`speech.command.run\` in ${join(configDir, GLOBAL_CONFIG_FILE)}`
            : `could not start ${program}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 0) return resolvePromise(Buffer.concat(out));
      const detail = stderr.trim();
      reject(new Error(`${program} ${code === null ? `was stopped by ${killedBy}` : `exited with code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
  });
}

/**
 * Reasons a `command` speech provider is not there, as the error `voiceover.generate` reports for an unknown
 * `command` id: it is configured only in the global config, never in a project.
 */
export function commandNotConfigured(configDir: string, available: string[]): RpcError {
  const file = join(configDir, GLOBAL_CONFIG_FILE);
  return new RpcError(
    ErrorCode.SpeechProviderNotFound,
    `The "${COMMAND_SPEECH_PROVIDER}" speech provider is not set up on this machine. Add \`"speech": { "command": { "run": ["<tts program>", "--out", "{out}"] } }\` ` +
      `to ${file}; it is read from there only, never from frameshell.json. Available: ${available.join(", ") || "none"}.`,
    { provider: COMMAND_SPEECH_PROVIDER, available },
  );
}
