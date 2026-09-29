import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type DaemonConnection,
  type DoctorResult,
  RpcError,
  type StatusResult,
  resolveSocketPath,
} from "@frameshell/protocol";
import { connectOrStartDaemon } from "./daemon-client.js";

/** CLI package version, used in `--version` and the handshake client id. */
export const CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const USAGE = `Usage: frameshell <command> [options]

Commands:
  init [dir] [--name <name>]   Scaffold a project in dir (default: current directory)
  status [--json]              Show daemon and the project enclosing the current directory
  doctor [--install] [--json]  Check ffmpeg/ffprobe, versions and encoders; exit 1 on problems.
                               --install downloads missing managed binaries first

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
        install: { type: "boolean", default: false },
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
  if (!["init", "status", "doctor"].includes(command) || rest.length > (command === "init" ? 1 : 0)) {
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
    } else if (command === "doctor") {
      if (values.install && !values.json) io.stderr("Installing missing managed binaries; first download can take minutes...\n");
      const report = await conn.request("doctor", { cwd: io.cwd, install: values.install });
      io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
      return report.problems.length > 0 ? 1 : 0;
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

function formatDoctor(report: DoctorResult): string {
  const lines = [`Platform ${report.platform} · data dir ${report.dataDir}`, "", "Binaries:"];
  for (const binary of report.binaries) {
    const state = binary.installed ? (binary.version ?? "not runnable") : "not installed";
    const pin = binary.pinned ? ` · pinned ${binary.pinned.version} (${binary.pinned.license}, ${binary.pinned.origin})` : "";
    lines.push(`  ${binary.name.padEnd(8)} ${state} · ${binary.source}${binary.path ? ` · ${binary.path}` : ""}${pin}`);
  }
  if (report.codecs.length > 0) {
    lines.push("", "Codecs:");
    for (const codec of report.codecs) {
      const state = !codec.compiled
        ? "no"
        : codec.works === null
          ? "yes"
          : codec.works
            ? "yes (test encode ok)"
            : "compiled, test encode failed";
      lines.push(`  ${`${codec.name} ${codec.kind}`.padEnd(28)} ${codec.label.padEnd(24)} ${state}`);
    }
  }
  lines.push("", report.problems.length === 0 ? "No problems found." : "Problems:");
  for (const problem of report.problems) lines.push(`  - ${problem}`);
  return `${lines.join("\n")}\n`;
}

function reportError(error: unknown, json: boolean, io: CliIo): void {
  const payload =
    error instanceof RpcError
      ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
      : { message: (error as Error)?.message ?? String(error) };
  io.stderr(json ? `${JSON.stringify({ error: payload }, null, 2)}\n` : `frameshell: ${payload.message}\n`);
}
