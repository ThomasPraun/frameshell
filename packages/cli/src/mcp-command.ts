import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { resolveSocketPath } from "@frameshell/protocol";
import { serveStdio } from "@frameshell/mcp";
import { connectOrStartDaemon } from "./daemon-client.js";
import { CLI_VERSION } from "./run.js";

/** Usage of `frameshell mcp`. */
export const MCP_USAGE = `Usage: frameshell mcp

Serve the Model Context Protocol on stdin/stdout for MCP clients (Claude Code, Codex, Cursor…).
Every daemon operation becomes a typed tool; timelines, history, transcripts and status are
resources. Tools act on the project enclosing the directory it starts in.

Register with Claude Code, from the project directory:
  claude mcp add frameshell -- frameshell mcp
`;

/** Process surface of `frameshell mcp`. */
export interface McpIo {
  stdin: Readable;
  stdout: Writable;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Run `frameshell mcp [--help]` until the MCP client disconnects. Operations
 * are attributed to `FRAMESHELL_SESSION`, else to a session id made for this
 * server, so they group into transactions the model can revert.
 * Returns the exit code.
 */
export async function runMcp(argv: string[], io: McpIo): Promise<number> {
  if (argv.includes("--help")) {
    io.stderr(MCP_USAGE);
    return 0;
  }
  if (argv.length > 0) {
    io.stderr(`\`frameshell mcp\` takes no arguments, got: ${argv.join(" ")}\n\n${MCP_USAGE}`);
    return 2;
  }
  const session = io.env["FRAMESHELL_SESSION"] || `mcp-${randomBytes(4).toString("hex")}`;
  await serveStdio({
    cwd: io.cwd,
    version: CLI_VERSION,
    stdin: io.stdin,
    stdout: io.stdout,
    connect: () =>
      connectOrStartDaemon({ socketPath: resolveSocketPath(io.env), client: `mcp/${CLI_VERSION}`, session, env: io.env }),
  });
  return 0;
}
