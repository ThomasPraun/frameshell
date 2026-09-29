import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type DaemonConnection, RpcError, type StatusResult, resolveSocketPath } from "@frameshell/protocol";
import { connectOrStartDaemon } from "./daemon-client.js";

/** CLI package version, used in `--version` and the handshake client id. */
export const CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const USAGE = `Usage: frameshell <command> [options]

Commands:
  init [dir] [--name <name>]   Scaffold a project in dir (default: current directory)
  status [--json]              Show daemon and the project enclosing the current directory

Options:
  --json       Machine-readable output
  --help       Show this help
  --version    Show the CLI version
`;

/** Process surface the CLI touches; injected so it can run in-process too. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Run one CLI invocation. Returns the exit code: 0 ok, 1 command failed,
 * 2 usage error. Never throws.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        name: { type: "string" },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  if (values.help || !command) {
    (values.help ? io.stdout : io.stderr)(USAGE);
    return values.help ? 0 : 2;
  }
  if ((command !== "init" && command !== "status") || rest.length > (command === "init" ? 1 : 0)) {
    io.stderr(`Unknown command or extra arguments: ${positionals.join(" ")}\n\n${USAGE}`);
    return 2;
  }

  let conn: DaemonConnection | undefined;
  try {
    conn = await connectOrStartDaemon({
      socketPath: resolveSocketPath(io.env),
      client: `cli/${CLI_VERSION}`,
      env: io.env,
    });
    if (command === "init") {
      const dir = resolve(io.cwd, rest[0] ?? ".");
      const result = await conn.request("project.init", values.name ? { dir, name: values.name } : { dir });
      io.stdout(
        values.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Created project "${result.project.name}" in ${result.project.dir}\n` +
              result.created.map((path) => `  ${path}\n`).join(""),
      );
    } else {
      const status = await conn.request("status", { cwd: io.cwd });
      io.stdout(values.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status, io.cwd));
    }
    return 0;
  } catch (error) {
    reportError(error, values.json, io);
    return 1;
  } finally {
    conn?.close();
  }
}

function formatStatus(status: StatusResult, cwd: string): string {
  const { daemon, project } = status;
  const lines = [
    `frameshelld ${daemon.daemonVersion} · protocol v${daemon.protocolVersion} · pid ${daemon.pid} · ` +
      `up ${(daemon.uptimeMs / 1000).toFixed(1)}s · ${daemon.clients} client${daemon.clients === 1 ? "" : "s"}`,
    project
      ? `Project: ${project.name} (${project.dir}) · schema v${project.schemaVersion}`
      : `Project: none in ${cwd}. Run \`frameshell init\` to create one.`,
  ];
  return `${lines.join("\n")}\n`;
}

function reportError(error: unknown, json: boolean, io: CliIo): void {
  const payload =
    error instanceof RpcError
      ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
      : { message: (error as Error)?.message ?? String(error) };
  io.stderr(json ? `${JSON.stringify({ error: payload }, null, 2)}\n` : `frameshell: ${payload.message}\n`);
}
