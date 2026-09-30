import { spawn } from "node:child_process";

/**
 * Runs whisper-cli to completion. `onStderrLine` sees every log line (model
 * load, backend, Metal shader compile, `-pp` progress). Rejects when the
 * process cannot start or exits non-zero.
 */
export type RunEngine = (binary: string, args: readonly string[], onStderrLine: (line: string) => void) => Promise<void>;

/** Lines of stderr kept for the error message when whisper-cli fails. */
const TAIL_LINES = 20;

/** {@link RunEngine} spawning the real binary; no shell, stdout discarded (results come from the JSON file). */
export const spawnEngine: RunEngine = (binary, args, onStderrLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const tail: string[] = [];
    let partial = "";
    const line = (text: string) => {
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      onStderrLine(text);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const text of lines) line(text);
    });
    child.once("error", (error) => reject(new Error(`could not run ${binary}: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (partial) line(partial);
      if (code === 0) return resolve();
      const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      reject(new Error(`whisper-cli ${reason}:\n${tail.join("\n")}`));
    });
  });
