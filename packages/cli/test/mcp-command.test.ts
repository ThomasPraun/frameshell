import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MCP_USAGE, runMcp } from "../src/mcp-command.js";

function io() {
  const errors: string[] = [];
  return {
    errors,
    io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: (text: string) => void errors.push(text), cwd: "/", env: {} },
  };
}

describe("frameshell mcp arguments", () => {
  it("documents --channel and the preview flag in --help", async () => {
    const run = io();
    expect(await runMcp(["--help"], run.io)).toBe(0);
    expect(run.errors.join("")).toBe(MCP_USAGE);
    expect(MCP_USAGE).toContain("--channel");
    expect(MCP_USAGE).toContain("--dangerously-load-development-channels server:frameshell");
  });

  it("refuses arguments other than --channel", async () => {
    const run = io();
    expect(await runMcp(["--channel", "--bogus"], run.io)).toBe(2);
    expect(run.errors.join("")).toContain("--bogus");
  });
});
