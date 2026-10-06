import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type DaemonConnection,
  type AssetImportResult,
  type DoctorResult,
  ErrorCode,
  type JobInfo,
  type MethodResult,
  type PluginInfo,
  type Progress,
  RpcError,
  type ScriptOutlineResult,
  type StatusResult,
  type TranscribeResult,
  type TranscribeVerifyResult,
  resolveSocketPath,
} from "@frameshell/protocol";
import { connectOrStartDaemon } from "./daemon-client.js";
import { type JobFollower, followJobs } from "./job-follower.js";
import { resolveAgent, resolveSession } from "./session.js";
import {
  TIMELINE_COMMANDS,
  TIMELINE_OPTIONS,
  TIMELINE_USAGE,
  type TimelineInvocation,
  timelineCommandFlags,
  UsageError,
  executeTimeline,
  parseTimelineCommand,
} from "./timeline-commands.js";

/** CLI package version, used in `--version` and the handshake client id. */
export const CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const USAGE = `Usage: frameshell <command> [options]

Commands:
  init [dir] [--name <name>] [--no-skill]
                               Scaffold a project in dir (default: current directory) with the agent skill
                               in .claude/skills/frameshell/ (asked first on a terminal; --no-skill: none)
  status [--json]              Show daemon, the enclosing project, jobs, rejected edits, open transactions
  doctor [--install] [--json]  Check ffmpeg/ffprobe, versions and encoders; exit 1 on problems.
                               --install downloads missing managed binaries first
  import <file…> [--link] [--wait]
                               Copy files into assets/ and queue proxies, waveforms, thumbnails.
                               --link hard-links instead of copying; --wait blocks until done
                               (exit 1 if any failed). Progress: \`frameshell status\`
  plugin install <spec>        Install and pin a plugin: github:<user>/<repo>[#ref], git+<url>[#ref],
                               an npm name[@version], or a local tarball from npm pack (./name-1.0.0.tgz)
  plugin remove <name>         Unpin and uninstall a plugin
  plugin list                  List the project's plugins and what they contribute
  transcribe <asset>           Write transcripts/<asset>.words.json (word-level, stable word ids).
             [--provider p] [--model m] [--language l]
                               First run downloads the engine and model (minutes, once)
  transcribe --verify <export> [--timeline id] [--provider p] [--model m] [--language l]
                               Re-transcribe an export and list the source words lost at cuts,
                               with timeline position and clip; exit 1 if any was lost
  render [--preset p] [--out file] [--timeline id]
                               Export a timeline to video (default preset: export.defaultPreset,
                               else youtube-1080p; default file: exports/<timeline>-<preset>.mp4).
                               Waits for the render job, printing progress; exit 1 if it fails
  frame --at <s> --out <png> [--timeline id] [--preset p]
                               Write the frame showing at <s> seconds as PNG (project resolution,
                               or the preset's)
  script outline <file>        Scenes (\`## \` headings) of a Markdown script: anchors for --script-ref,
                               linked clips, frontmatter (title, target_duration, aspect)
  mcp                          Serve MCP on stdio for agents: every operation as a typed tool, project
                               files as resources. Register: claude mcp add frameshell -- frameshell mcp
  <plugin> <command> [args…]   Run a plugin-provided command

${TIMELINE_USAGE}
Options:
  --json       Machine-readable output
  --trust      Trust this project's plugins without asking. Plugins run with full access to your machine.
  --help       Show this help
  --version    Show the CLI version
`;

const BUILTINS = new Set(["init", "status", "doctor", "import", "plugin", "transcribe", "render", "frame", "script", ...TIMELINE_COMMANDS]);

/** Flags every command accepts. */
export const GLOBAL_FLAGS = ["json", "trust", "help", "version"] as const;

/** Options the parser knows that no timeline command takes (the timeline ones are in `TIMELINE_OPTIONS`). */
const NON_TIMELINE_FLAGS = ["install", "link", "wait", "no-skill", "provider", "model", "language", "verify"] as const;

/** Flags each built-in, non-timeline command takes besides {@link GLOBAL_FLAGS}; enforced when parsing. */
const BUILTIN_FLAGS: Record<string, readonly string[]> = {
  init: ["name", "no-skill"],
  status: [],
  doctor: ["install"],
  import: ["link", "wait"],
  "plugin install": [],
  "plugin remove": [],
  "plugin list": [],
  transcribe: ["verify", "timeline", "provider", "model", "language"],
  render: ["preset", "out", "timeline"],
  frame: ["at", "out", "timeline", "preset"],
  "script outline": [],
  mcp: [],
};

/**
 * Every built-in command (`status`, `clip add`, …) and the flags it takes
 * besides {@link GLOBAL_FLAGS}: the CLI surface docs and skills may name.
 * Plugin commands are not included.
 */
export function cliCommands(): ReadonlyMap<string, readonly string[]> {
  return new Map<string, readonly string[]>([...Object.entries(BUILTIN_FLAGS), ...timelineCommandFlags()]);
}

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
  | { kind: "init"; dir: string | undefined; name: string | undefined; skill: false | undefined }
  | { kind: "status" }
  | { kind: "doctor"; install: boolean }
  | { kind: "import"; files: string[]; link: boolean; wait: boolean }
  | { kind: "plugin.install"; spec: string }
  | { kind: "plugin.remove"; name: string }
  | { kind: "plugin.list" }
  | { kind: "plugin.run"; plugin: string; command: string; args: string[] }
  | { kind: "transcribe"; asset: string; provider?: string; model?: string; language?: string }
  | { kind: "transcribe.verify"; export: string; timeline?: string; provider?: string; model?: string; language?: string }
  | { kind: "render"; timeline?: string; preset?: string; out?: string }
  | { kind: "frame"; at: number; out: string; timeline?: string; preset?: string }
  | { kind: "script.outline"; file: string }
  | TimelineInvocation;

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
  if (firstWord === "mcp") {
    io.stderr("`frameshell mcp` serves MCP over the process's own stdin/stdout; run the `frameshell` binary.\n");
    return 2;
  }
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
          ...TIMELINE_OPTIONS,
          json: { type: "boolean", default: false },
          trust: { type: "boolean", default: false },
          install: { type: "boolean", default: false },
          link: { type: "boolean", default: false },
          wait: { type: "boolean", default: false },
          name: { type: "string" },
          "no-skill": { type: "boolean", default: false },
          provider: { type: "string" },
          model: { type: "string" },
          language: { type: "string" },
          verify: { type: "string" },
          preset: { type: "string" },
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
    let builtin: Invocation | null;
    try {
      checkBuiltinFlags(positionals, values);
      builtin = TIMELINE_COMMANDS.has(positionals[0]!) ? parseTimelineCommand(positionals, values) : parseBuiltin(positionals, values);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      io.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
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
      session: resolveSession(io.env),
      agent: resolveAgent(io.env),
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

/** Reject flags a built-in command does not take, instead of ignoring them. Timeline commands: only the flags of other commands here, their own per command in `parseTimelineCommand`. */
function checkBuiltinFlags(positionals: string[], values: Record<string, unknown>): void {
  const [command, sub] = positionals;
  const key = command === "plugin" || command === "script" ? `${command} ${sub ?? ""}` : command!;
  if (TIMELINE_COMMANDS.has(command!)) {
    // Timeline flags are checked per command by `parseTimelineCommand`; these belong to other commands.
    const foreign = NON_TIMELINE_FLAGS.filter((flag) => values[flag] !== undefined && values[flag] !== false);
    if (foreign.length > 0) throw new UsageError(`\`frameshell ${command}\` does not take ${foreign.map((flag) => `--${flag}`).join(", ")}.`);
    return;
  }
  const allowed = BUILTIN_FLAGS[key];
  if (!allowed) return;
  const extra = Object.keys(values).filter(
    (flag) => values[flag] !== undefined && values[flag] !== false && !allowed.includes(flag) && !(GLOBAL_FLAGS as readonly string[]).includes(flag),
  );
  if (extra.length > 0) throw new UsageError(`\`frameshell ${key}\` does not take ${extra.map((flag) => `--${flag}`).join(", ")}.`);
}

function parseBuiltin(
  positionals: string[],
  options: {
    name?: string | undefined;
    "no-skill"?: boolean | undefined;
    install: boolean;
    link: boolean;
    wait: boolean;
    provider?: string | undefined;
    model?: string | undefined;
    language?: string | undefined;
    verify?: string | undefined;
    preset?: string | undefined;
    timeline?: string | undefined;
    out?: string | undefined;
    at?: string | undefined;
  },
): Invocation | null {
  const [command, ...rest] = positionals;
  if (command === "render" || command === "frame") {
    if (rest.length > 0) return null;
    const { preset, timeline, out } = options;
    const common = { ...(timeline ? { timeline } : {}), ...(preset ? { preset } : {}) };
    if (command === "render") return { kind: "render", ...common, ...(out ? { out } : {}) };
    const at = Number(options.at);
    if (options.at === undefined || options.at.trim() === "" || !Number.isFinite(at) || at < 0) {
      throw new UsageError("`frameshell frame` needs --at <seconds> (a number >= 0), e.g. --at 12.5.");
    }
    if (!out) throw new UsageError("`frameshell frame` needs --out <file.png>.");
    return { kind: "frame", at, out, ...common };
  }
  if (command === "transcribe") {
    const { provider, model, language } = options;
    if (options.verify !== undefined) {
      if (rest.length > 0) throw new UsageError("`frameshell transcribe --verify <export>` takes no asset: it checks the export against every clip.");
      return {
        kind: "transcribe.verify",
        export: options.verify,
        ...(options.timeline ? { timeline: options.timeline } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
      };
    }
    if (rest.length !== 1) return null;
    return {
      kind: "transcribe",
      asset: rest[0]!,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(language ? { language } : {}),
    };
  }
  if (command === "script") return rest.length === 2 && rest[0] === "outline" ? { kind: "script.outline", file: rest[1]! } : null;
  if (command === "init" && rest.length <= 1) {
    return { kind: "init", dir: rest[0], name: options.name, skill: options["no-skill"] ? false : undefined };
  }
  if (command === "status" && rest.length === 0) return { kind: "status" };
  if (command === "doctor" && rest.length === 0) return { kind: "doctor", install: options.install };
  if (command === "import" && rest.length > 0) return { kind: "import", files: rest, link: options.link, wait: options.wait };
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
      const agentSkill = inv.skill ?? (await offerSkill(io));
      const result = await conn.request("project.init", { dir, agentSkill, ...(inv.name ? { name: inv.name } : {}) });
      if (flags.json) return json(result);
      const skillDir = `${SKILL_DIR}/`;
      const skill = result.created.some((path) => path.startsWith(skillDir))
        ? `Agent skill: ${skillDir} (Claude Code and compatible agents load it from there)\n`
        : "";
      return (
        `Created project "${result.project.name}" in ${result.project.dir}\n` +
        result.created
          .filter((path) => !path.startsWith(skillDir))
          .map((path) => `  ${path}\n`)
          .join("") +
        skill
      );
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
    case "import": {
      const files = inv.files.map((file) => resolve(cwd, file));
      const follower = inv.wait ? await followJobs(conn, cwd) : undefined;
      const result = await conn.request("asset.import", { cwd, files, mode: inv.link ? "link" : "copy" });
      if (!follower) return flags.json ? json(result) : formatImport(result);
      const jobs = await waitForJobs(follower, result.imported.map((entry) => entry.job.id), flags.json ? undefined : io);
      const imported = result.imported.map((entry) => ({ ...entry, job: jobs.get(entry.job.id) ?? entry.job }));
      if (imported.some((entry) => entry.job.state !== "done")) outcome.code = 1;
      return flags.json ? json({ ...result, imported }) : formatImport({ ...result, imported });
    }
    case "plugin.install": {
      await settleTrust(conn, flags, io);
      const result = await conn.request("plugin.install", { cwd, spec: inv.spec });
      if (flags.json) return json(result);
      const skills = result.skills.length > 0 ? `  agent skills: ${result.skills.join(", ")}\n` : "";
      const warnings = result.warnings.map((warning) => `  warning: ${warning}\n`).join("");
      return `Installed ${result.name} in ${result.dir}\n  pinned: ${result.pin}\n${formatContributions(result.plugin, "  ")}${skills}${warnings}`;
    }
    case "plugin.remove": {
      const result = await conn.request("plugin.remove", { cwd, name: inv.name });
      if (flags.json) return json(result);
      const skills = result.skills.length > 0 ? `  unlinked agent skills: ${result.skills.join(", ")}\n` : "";
      return `Removed ${result.name} (was ${result.pin}) from ${result.dir}\n${skills}`;
    }
    case "plugin.list": {
      await settleTrust(conn, flags, io);
      const result = await conn.request("plugin.list", { cwd });
      return flags.json ? json(result) : formatPluginList(result);
    }
    case "transcribe": {
      await settleTrust(conn, flags, io);
      const { kind: _kind, ...params } = inv;
      const result = await conn.request(
        "transcribe",
        { cwd, ...params },
        flags.json ? {} : { onProgress: progressPrinter(io) },
      );
      return flags.json ? json(result) : formatTranscribe(result);
    }
    case "script.outline": {
      const result = await conn.request("script.outline", { cwd, file: inv.file });
      return flags.json ? json(result) : formatOutline(result);
    }
    case "transcribe.verify": {
      await settleTrust(conn, flags, io);
      const { kind: _kind, export: file, ...params } = inv;
      const result = await conn.request(
        "transcribe.verify",
        { cwd, export: resolve(cwd, file), ...params },
        flags.json ? {} : { onProgress: progressPrinter(io) },
      );
      if (result.lost.length > 0) outcome.code = 1;
      return flags.json ? json(result) : formatVerify(result);
    }
    case "timeline": {
      // Adapter clips need the project's plugins loaded, which may need a trust decision.
      const { type, props } = inv.params;
      if (props !== undefined || (typeof type === "string" && type !== "media" && type !== "timeline")) {
        await settleTrust(conn, flags, io);
      }
      return executeTimeline(conn, inv, cwd, flags.json);
    }
    case "render": {
      // Plugin presets load only for trusted projects.
      await settleTrust(conn, flags, io);
      const { kind: _kind, out, ...params } = inv;
      const follower = await followJobs(conn, cwd);
      const result = await conn.request("render", { cwd, ...params, ...(out ? { out: resolve(cwd, out) } : {}) });
      if (!flags.json) {
        io.stderr(
          `Rendering timelines/${result.timeline}.json -> ${result.output}\n` +
            `  ${result.preset} · ${result.width}x${result.height} · ${result.fps} fps · ${result.duration} s · ` +
            `${result.segments} segment(s) · ${result.loudness} LUFS (job ${result.job.id})\n` +
            result.warnings.map((warning) => `  warning: ${warning}\n`).join(""),
        );
      }
      const job = (await waitForJobs(follower, [result.job.id], flags.json ? undefined : io)).get(result.job.id) ?? result.job;
      if (job.state !== "done") outcome.code = 1;
      if (flags.json) return json({ ...result, job });
      return job.state === "done" ? `Rendered ${result.output}\n` : `Render failed: ${job.error ?? job.state}\n`;
    }
    case "frame": {
      const { kind: _kind, out, ...params } = inv;
      const result = await conn.request("frame", { cwd, ...params, out: resolve(cwd, out) });
      return flags.json
        ? json(result)
        : `Wrote ${result.path} (frame ${result.frame} at ${result.at} s, ${result.clip ?? "gap"}, ${result.width}x${result.height})\n`;
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

/** Where `project.init` puts the core agent skill. */
const SKILL_DIR = ".claude/skills/frameshell";

/**
 * Ask whether to install the agent skill when someone can answer; the
 * default is yes. Without a terminal (agents, scripts) it is installed.
 */
async function offerSkill(io: CliIo): Promise<boolean> {
  if (!io.prompt) return true;
  const answer = await io.prompt(
    `Install the Frameshell agent skill in ${SKILL_DIR}/? It teaches Claude Code and compatible agents ` +
      "this project's CLI, history and review loop. [Y/n] ",
  );
  return !/^\s*n(o)?\s*$/i.test(answer);
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

/**
 * Wait until every job in `ids` has finished, following `job.progress`
 * events. Progress lines go to stderr when `io` is given, one per visible
 * change. Returns the final state of each job.
 */
async function waitForJobs(follower: JobFollower, ids: string[], io?: CliIo): Promise<Map<string, JobInfo>> {
  const last = new Map<string, string>();
  return follower.wait(ids, (job) => {
    const line = formatJob(job);
    if (io && last.get(job.id) !== line) io.stderr(`${line}\n`);
    last.set(job.id, line);
  });
}

function formatImport(result: AssetImportResult): string {
  return result.imported
    .map(({ source, asset, copied, job }) => {
      const how = copied ? `imported from ${source}` : "already in assets/";
      return `${asset}  ${how}\n  ${formatJob(job)}\n`;
    })
    .join("");
}

/** `42s`, `5m 3s`, `2h 10m`, `3d 4h`: coarse, for ages. */
function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

function formatJob(job: JobInfo): string {
  const what = `${job.kind} ${job.asset}`;
  switch (job.state) {
    case "running":
      return `${what}: ${job.step ?? "starting"} ${Math.round(job.progress * 100)}% (${job.id})`;
    case "done":
      return `${what}: done${job.cached ? " (cached, nothing re-encoded)" : ""} (${job.id})`;
    case "failed":
      return `${what}: failed: ${job.error ?? "unknown error"} (${job.id})`;
    default:
      return `${what}: ${job.state} (${job.id})`;
  }
}

/**
 * Progress lines on stderr: one per new message, plus every 10 % of a step,
 * so logs and agent terminals stay readable.
 */
function progressPrinter(io: CliIo): (progress: Progress) => void {
  let lastMessage = "";
  let lastDecile = -1;
  return ({ message, fraction }) => {
    const decile = fraction === undefined ? -1 : Math.floor(fraction * 10);
    if (message === lastMessage && decile === lastDecile) return;
    io.stderr(`${message}${fraction === undefined ? "" : ` ${Math.round(fraction * 100)}%`}\n`);
    lastMessage = message;
    lastDecile = decile;
  };
}

function formatTranscribe(result: TranscribeResult): string {
  const facts = [
    `${result.words} words`,
    `${result.provider} ${result.model}`,
    ...(result.language ? [result.language] : []),
    ...(result.device ? [result.device] : []),
    `${result.seconds.toFixed(1)} s`,
  ];
  const lines = [`Transcribed ${result.asset} -> ${result.transcript}`, `  ${facts.join(" · ")}`];
  if (result.audioSource !== result.asset) lines.push(`  audio from ${result.audioSource}`);
  if (result.keptEdits > 0 || result.droppedEdits.length > 0) {
    const dropped = result.droppedEdits.length > 0 ? `; dropped ${result.droppedEdits.length} (${result.droppedEdits.join(", ")})` : "";
    lines.push(`  kept ${result.keptEdits} human edit${result.keptEdits === 1 ? "" : "s"}${dropped}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatOutline(outline: ScriptOutlineResult): string {
  const { meta, scenes } = outline;
  const header = [
    outline.path,
    ...(meta.title !== null ? [`"${meta.title}"`] : []),
    ...(meta.targetDuration !== null ? [`target ${meta.targetDuration} s`] : []),
    ...(meta.aspect !== null ? [meta.aspect] : []),
    `${scenes.length} scene${scenes.length === 1 ? "" : "s"}`,
  ].join(" · ");
  const lines = [header];
  if (outline.clips.length > 0) lines.push(`  whole script  clips: ${outline.clips.map(({ timeline, clip }) => `${timeline}/${clip}`).join(", ")}`);
  if (scenes.length === 0) lines.push("  (no scenes: add `## ` headings)");
  const width = (values: string[]) => Math.max(0, ...values.map((value) => value.length));
  const [slugW, titleW, lineW] = [
    width(scenes.map((scene) => `#${scene.slug}`)),
    width(scenes.map((scene) => scene.title)),
    width(scenes.map((scene) => String(scene.line))),
  ];
  for (const scene of scenes) {
    const clips = scene.clips.length > 0 ? `clips: ${scene.clips.map(({ timeline, clip }) => `${timeline}/${clip}`).join(", ")}` : "no clips";
    const words = `${scene.words} word${scene.words === 1 ? "" : "s"}`;
    lines.push(`  ${`#${scene.slug}`.padEnd(slugW)}  ${scene.title.padEnd(titleW)}  line ${String(scene.line).padEnd(lineW)}  ${words}  ${clips}`);
  }
  if (outline.unresolved.length > 0) {
    lines.push("Unresolved refs:", ...outline.unresolved.map(({ timeline, clip, scriptRef }) => `  ${timeline}/${clip} -> ${scriptRef}`));
  }
  if (outline.warnings.length > 0) lines.push("Warnings:", ...outline.warnings.map((warning) => `  ${warning}`));
  return `${lines.join("\n")}\n`;
}

function formatVerify(result: TranscribeVerifyResult): string {
  const seconds = (value: number) => `${value.toFixed(3)} s`;
  const where = (word: TranscribeVerifyResult["lost"][number]) => {
    const cut = word.cut ? ` · ${word.cut.edge} cut at ${seconds(word.cut.at)}${word.clipped ? ", clipped" : ""}` : "";
    return `  ${seconds(word.at)}  "${word.text}"  clip ${word.clip} (track ${word.track})${cut} · ${word.word} · confidence ${word.confidence.toFixed(2)}`;
  };
  const lines = [
    `Verified ${result.export} against timeline ${result.timeline} (revision ${result.revision}): ` +
      `${result.expected} words expected, ${result.heard} heard, agreement ${result.confidence.toFixed(2)}`,
    `  ${result.provider} ${result.model}${result.language ? ` · ${result.language}` : ""} · ${result.seconds.toFixed(1)} s`,
  ];
  lines.push(result.lost.length === 0 ? "No words lost at cuts." : `Lost at cuts (${result.lost.length}):`);
  for (const word of result.lost) lines.push(where(word));
  if (result.uncertain.length > 0) {
    lines.push(`Uncertain, check by ear (${result.uncertain.length}):`);
    for (const word of result.uncertain) {
      lines.push(`${where(word)} · ${word.reason}${word.heardAs === null ? "" : ` (heard "${word.heardAs}")`}`);
    }
  }
  for (const clip of result.unchecked) {
    const why = clip.reason === "no-transcript" ? "no transcript" : "transcript is stale";
    lines.push(`Not checked: clip ${clip.clip} (${clip.asset}): ${why}; run \`frameshell transcribe ${clip.asset}\``);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
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
  // Active jobs and failures matter; finished ones are noise.
  const shown = status.jobs.filter((job) => job.state !== "done" && job.state !== "canceled");
  const active = status.jobs.filter((job) => job.state === "queued" || job.state === "running").length;
  if (status.jobs.length > 0) {
    lines.push(`Jobs: ${active} active, ${status.jobs.length - active} finished`);
    for (const job of shown) lines.push(`  ${formatJob(job)}`);
  }
  if (status.rejections.length > 0) {
    lines.push(`Rejected direct edits (${status.rejections.length}):`);
    for (const r of status.rejections) {
      const revisions = [r.revision === null ? "unreadable revision" : `revision ${r.revision}`];
      if (r.current !== null) revisions.push(`current ${r.current}`);
      const reason = r.reason === "unknown" ? "unknown reason" : r.reason;
      lines.push(`  ${r.at}  ${r.timeline}: ${reason} (${revisions.join(", ")}), kept at ${r.preserved}`);
      if (r.reason === "invalid") lines.push(`    ${r.message.split("\n").join("\n    ")}`);
    }
    lines.push("  Delete a kept file once handled to drop it from this list.");
  }
  if (status.transactions.length > 0) {
    lines.push(`Open transactions (${status.transactions.length}):`);
    for (const t of status.transactions) {
      const age = t.ageMs === null ? "open since unknown" : `open ${duration(t.ageMs)}`;
      const where = t.timelines.length > 0 ? ` · timelines ${t.timelines.join(", ")}` : "";
      const ops = `${t.operations} operation${t.operations === 1 ? "" : "s"}`;
      lines.push(`  ${t.tx} ${JSON.stringify(t.label)} · ${t.author} · ${ops} · ${age}${where}`);
    }
    lines.push("  End one left by a closed shell: FRAMESHELL_SESSION=<session> frameshell tx commit (or tx abort).");
  }
  return `${lines.join("\n")}\n`;
}

function formatDoctor(report: DoctorResult): string {
  const lines = [`Platform ${report.platform} · data dir ${report.dataDir}`, "", "Binaries:"];
  for (const binary of report.binaries) {
    const state = binary.installed ? (binary.version ?? "not runnable") : "not installed";
    const pinned = binary.pinned;
    const gpu = pinned?.accelerator ? `, ${pinned.accelerator}` : "";
    const pin = pinned ? ` · pinned ${pinned.version} (${pinned.license}, ${pinned.origin}${gpu})` : "";
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
