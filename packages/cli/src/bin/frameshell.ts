#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runMcp } from "../mcp-command.js";
import { type CliIo, runCli } from "../run.js";

const argv = process.argv.slice(2);
const stderr = (text: string) => void process.stderr.write(text);

if (argv[0] === "mcp") {
  // Long-lived: stdout carries MCP messages only.
  process.exitCode = await runMcp(argv.slice(1), { stdin: process.stdin, stdout: process.stdout, stderr, cwd: process.cwd(), env: process.env });
} else {
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr,
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
  process.exitCode = await runCli(argv, io);
}
