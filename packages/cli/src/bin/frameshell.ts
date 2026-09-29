#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { type CliIo, runCli } from "../run.js";

const io: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
};
// Only a human at a terminal can answer; agents and pipes get the `--trust` hint instead.
if (process.stdin.isTTY && process.stderr.isTTY) {
  io.prompt = async (question) => {
    // stderr: keeps stdout clean for `--json`.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

process.exitCode = await runCli(process.argv.slice(2), io);
