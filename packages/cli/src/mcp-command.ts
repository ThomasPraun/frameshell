import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { resolveSocketPath } from "@frameshell/protocol";
import { serveStdio } from "@frameshell/mcp";
import { connectOrStartDaemon } from "./daemon-client.js";
import { CLI_VERSION } from "./run.js";
import { resolveMcpAgent } from "./session.js";

/** Usage of `frameshell mcp`. */
export const MCP_USAGE = `Usage: frameshell mcp [--channel]

Serve the Model Context Protocol on stdin/stdout for MCP clients (Claude Code, Codex, Cursor…).
Every daemon operation becomes a typed tool; timelines, history, transcripts and status are
resources. Tools act on the project enclosing the directory it starts in.

--channel (or FRAMESHELL_CHANNEL=1) also pushes references sent from the app ("Chat about this")
into the session as Claude Code channel events, so Claude reacts without a message from you.
Channels are a Claude Code research preview: start Claude Code with
  claude --dangerously-load-development-channels server:frameshell
Team and Enterprise organizations must enable channels first. See docs/mcp.md.

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
 * server, so they group into transactions the model can revert;
 * `FRAMESHELL_AGENT` names the agent they are journaled under, else the MCP client does (`agent:claude:<session>` for Claude Code).
 * Returns the exit code.
 */
export async function runMcp(argv: string[], io: McpIo): Promise<number> {
  if (argv.includes("--help")) {
    io.stderr(MCP_USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--channel");
  if (unknown.length > 0) {
    io.stderr(`\`frameshell mcp\` takes only \`--channel\`, got: ${unknown.join(" ")}\n\n${MCP_USAGE}`);
    return 2;
  }
  const channel = argv.includes("--channel") || /^(1|true|yes|on)$/i.test(io.env["FRAMESHELL_CHANNEL"] ?? "");
  const session = io.env["FRAMESHELL_SESSION"] || `mcp-${randomBytes(4).toString("hex")}`;
  await serveStdio({
    cwd: io.cwd,
    version: CLI_VERSION,
    channel,
    stdin: io.stdin,
    stdout: io.stdout,
    connect: (mcpClient) =>
      connectOrStartDaemon({
        socketPath: resolveSocketPath(io.env),
        client: `mcp/${CLI_VERSION}`,
        session,
        agent: resolveMcpAgent(io.env, mcpClient),
        env: io.env,
      }),
  });
  return 0;
}
