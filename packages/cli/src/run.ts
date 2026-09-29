import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type DaemonConnection,
  type DoctorResult,
  ErrorCode,
  type MethodResult,
  type PluginInfo,
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
  plugin install <spec>        Install and pin a plugin: github:<user>/<repo>[#ref], git+<url>[#ref],
                               or an npm name[@version]
  plugin remove <name>         Unpin and uninstall a plugin
  plugin list                  List the project's plugins and what they contribute
  <plugin> <command> [args…]   Run a plugin-provided command

Options:
  --json       Machine-readable output
  --trust      Trust this project's plugins without asking. Plugins run with full access to your machine.
  --help       Show this help
  --version    Show the CLI version
`;

const BUILTINS = new Set(["init", "status", "doctor", "plugin"]);

/** Process surface the CLI touches; injected so it can run in-process too. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Ask the user one question and resolve with the answer. Omit when no one
   * can answer (no TTY): trust questions then fail with a `--trust` hint.
   */
  prompt?: (question: string) => Promise<string>;
}

type Invocation =
  | { kind: "init"; dir: string | undefined; name: string | undefined }
  | { kind: "status" }
  | { kind: "doctor"; install: boolean }
  | { kind: "plugin.install"; spec: string }
  | { kind: "plugin.remove"; name: string }
  | { kind: "plugin.list" }
  | { kind: "plugin.run"; plugin: string; command: string; args: string[] };

interface Flags {
  json: boolean;
  trust: boolean;
  install: boolean;
}

/**
 * Run one CLI invocation. Returns the exit code: 0 ok, 1 command failed,
 * 2 usage error (including an unknown plugin command). Never throws.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const firstWord = argv.find((arg) => !arg.startsWith("-"));
  let invocation: Invocation;
  let flags: Flags;
  if (firstWord !== undefined && !BUILTINS.has(firstWord)) {
    // Plugin command: every other flag belongs to the plugin, so no strict parsing here.
    flags = { json: argv.includes("--json"), trust: argv.includes("--trust"), install: false };
    const [plugin, command, ...args] = argv.filter((arg) => arg !== "--json" && arg !== "--trust");
    if (plugin === undefined || command === undefined || plugin.startsWith("-") || command.startsWith("-")) {
      io.stderr(`Unknown command: ${argv.join(" ")}\n\n${USAGE}`);
      return 2;
    }
    invocation = { kind: "plugin.run", plugin, command, args };
  } else {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          json: { type: "boolean", default: false },
          trust: { type: "boolean", default: false },
          install: { type: "boolean", default: false },
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
    if (values.version) {
      io.stdout(`${CLI_VERSION}\n`);
      return 0;
    }
    if (values.help || positionals.length === 0) {
      (values.help ? io.stdout : io.stderr)(USAGE);
      return values.help ? 0 : 2;
    }
    flags = { json: values.json, trust: values.trust, install: values.install };
    const builtin = parseBuiltin(positionals, values.name, values.install);
    if (!builtin) {
      io.stderr(`Unknown command or wrong arguments: ${positionals.join(" ")}\n\n${USAGE}`);
      return 2;
    }
    invocation = builtin;
  }

  let conn: DaemonConnection | undefined;
  try {
    conn = await connectOrStartDaemon({
      socketPath: resolveSocketPath(io.env),
      client: `cli/${CLI_VERSION}`,
      session: io.env["FRAMESHELL_SESSION"],
      env: io.env,
    });
    const outcome = { code: 0 };
    const text = await execute(conn, invocation, flags, io, outcome);
    io.stdout(text);
    return outcome.code;
  } catch (error) {
    reportError(error, flags.json, io);
    return error instanceof RpcError && error.code === ErrorCode.CommandNotFound ? 2 : 1;
  } finally {
    conn?.close();
  }
}

function parseBuiltin(positionals: string[], name: string | undefined, install: boolean): Invocation | null {
  const [command, ...rest] = positionals;
  if (command === "init" && rest.length <= 1) return { kind: "init", dir: rest[0], name };
  if (command === "status" && rest.length === 0) return { kind: "status" };
  if (command === "doctor" && rest.length === 0) return { kind: "doctor", install };
  if (command !== "plugin") return null;
  const [sub, arg, ...extra] = rest;
  if (extra.length > 0) return null;
  if (sub === "install" && arg) return { kind: "plugin.install", spec: arg };
  if (sub === "remove" && arg) return { kind: "plugin.remove", name: arg };
  if (sub === "list" && !arg) return { kind: "plugin.list" };
  return null;
}

/** Runs the invocation and returns what to print on stdout. Sets `outcome.code` when the command succeeded but reports failure. */
async function execute(conn: DaemonConnection, inv: Invocation, flags: Flags, io: CliIo, outcome: { code: number }): Promise<string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const cwd = io.cwd;
  switch (inv.kind) {
    case "init": {
      const dir = resolve(cwd, inv.dir ?? ".");
      const result = await conn.request("project.init", inv.name ? { dir, name: inv.name } : { dir });
      return flags.json
        ? json(result)
        : `Created project "${result.project.name}" in ${result.project.dir}\n` +
            result.created.map((path) => `  ${path}\n`).join("");
    }
    case "status": {
      const status = await conn.request("status", { cwd });
      return flags.json ? json(status) : formatStatus(status, cwd);
    }
    case "doctor": {
      if (flags.install && !flags.json) io.stderr("Installing missing managed binaries; first download can take minutes...\n");
      const report = await conn.request("doctor", { cwd, install: inv.install });
      if (report.problems.length > 0) outcome.code = 1;
      return flags.json ? json(report) : formatDoctor(report);
    }
    case "plugin.install": {
      await settleTrust(conn, flags, io);
      const result = await conn.request("plugin.install", { cwd, spec: inv.spec });
      return flags.json
        ? json(result)
        : `Installed ${result.name} in ${result.dir}\n  pinned: ${result.pin}\n${formatContributions(result.plugin, "  ")}`;
    }
    case "plugin.remove": {
      const result = await conn.request("plugin.remove", { cwd, name: inv.name });
      return flags.json ? json(result) : `Removed ${result.name} (was ${result.pin}) from ${result.dir}\n`;
    }
    case "plugin.list": {
      await settleTrust(conn, flags, io);
      const result = await conn.request("plugin.list", { cwd });
      return flags.json ? json(result) : formatPluginList(result);
    }
    case "plugin.run": {
      await settleTrust(conn, flags, io);
      const result = await conn.request("plugin.run", { cwd, plugin: inv.plugin, command: inv.command, args: inv.args });
      if (flags.json) return json(result);
      if (result.output !== null) return result.output.endsWith("\n") ? result.output : `${result.output}\n`;
      return result.data === null || result.data === undefined ? "" : json(result.data);
    }
  }
}

/**
 * First load of a project declaring untrusted plugins (SPEC §6.6): `--trust`
 * records trust; otherwise ask once when someone can answer. A `no` is stored
 * too, so the user is not asked again for the same plugin list.
 */
async function settleTrust(conn: DaemonConnection, flags: Flags, io: CliIo): Promise<void> {
  const { trust } = await conn.request("status", { cwd: io.cwd });
  if (!trust || trust.state === "not-required" || trust.state === "trusted") return;
  if (flags.trust) {
    await conn.request("project.trust", { cwd: io.cwd, decision: "trust" });
    return;
  }
  if (trust.state !== "unknown" || !io.prompt) return;
  const listed = Object.entries(trust.plugins)
    .map(([name, pin]) => `  ${name}  ${pin}\n`)
    .join("");
  const answer = await io.prompt(
    `This project declares plugins:\n${listed}` +
      "Plugins run inside frameshelld with full access to your files and network.\n" +
      "Trust this project and load its plugins? [y/N] ",
  );
  const decision = /^\s*y(es)?\s*$/i.test(answer) ? "trust" : "deny";
  await conn.request("project.trust", { cwd: io.cwd, decision });
}

function formatStatus(status: StatusResult, cwd: string): string {
  const { daemon, project, trust } = status;
  const lines = [
    `frameshelld ${daemon.daemonVersion} · protocol v${daemon.protocolVersion} · pid ${daemon.pid} · ` +
      `up ${(daemon.uptimeMs / 1000).toFixed(1)}s · ${daemon.clients} client${daemon.clients === 1 ? "" : "s"}`,
    project
      ? `Project: ${project.name} (${project.dir}) · schema v${project.schemaVersion}`
      : `Project: none in ${cwd}. Run \`frameshell init\` to create one.`,
  ];
  if (trust && trust.state !== "not-required") {
    const count = Object.keys(trust.plugins).length;
    lines.push(`Plugins: ${count} declared, ${trustLabel(trust.state)}`);
  }
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

function trustLabel(state: string): string {
  if (state === "trusted") return "trusted";
  if (state === "denied") return "not trusted (denied; pass --trust to load them)";
  return "not trusted (pass --trust to load them)";
}

function formatPluginList(result: MethodResult<"plugin.list">): string {
  if (result.plugins.length === 0) {
    return `No plugins in ${result.dir}. Install one with \`frameshell plugin install <spec>\`.\n`;
  }
  const header = `Plugins in ${result.dir} (${trustLabel(result.trust)}):\n`;
  return (
    header +
    result.plugins
      .map((plugin) => {
        const version = plugin.version ? ` ${plugin.version}` : "";
        const line = `  ${plugin.name}${version}  ${plugin.status}  ${plugin.pin}\n`;
        const error = plugin.error ? `    error: ${plugin.error.replace(/\n/g, "\n    ")}\n` : "";
        return line + error + formatContributions(plugin, "    ");
      })
      .join("")
  );
}

function formatContributions(plugin: PluginInfo, indent: string): string {
  const c = plugin.contributes;
  if (!c) return "";
  const rows: Array<[string, string[]]> = [
    ["commands", c.commands],
    ["export presets", c.exportPresets],
    ["clip types", c.clipTypes],
    ["transcription providers", c.transcriptionProviders],
    ["skills", c.skills],
  ];
  return rows
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => `${indent}${label}: ${items.join(", ")}\n`)
    .join("");
}

function reportError(error: unknown, json: boolean, io: CliIo): void {
  const payload =
    error instanceof RpcError
      ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
      : { message: (error as Error)?.message ?? String(error) };
  io.stderr(json ? `${JSON.stringify({ error: payload }, null, 2)}\n` : `frameshell: ${payload.message}\n`);
}
