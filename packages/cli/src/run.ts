import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type DaemonConnection,
  type AssetImportResult,
  type DoctorResult,
  ErrorCode,
  type FrameFormat,
  type GcResult,
  type JobInfo,
  type MethodResult,
  PROPOSAL_WAIT_MAX_S,
  type PluginInfo,
  type Proposal,
  type Progress,
  type ReviewState,
  RpcError,
  type ScriptCheckResult,
  type ScriptOutlineResult,
  type StatusResult,
  type TranscribeResult,
  type TranscribeSpeakersResult,
  type TranscribeVerifyResult,
  resolveSocketPath,
} from "@frameshell/protocol";
import { connectOrStartDaemon } from "./daemon-client.js";
import { type JobFollower, followJobs } from "./job-follower.js";
import { PEOPLE_FLAGS, PEOPLE_USAGE, type PeopleInvocation, executePeople, parsePeople } from "./people-commands.js";
import { SHOOT_FLAGS, SHOOT_USAGE, type ShootInvocation, executeShoot, parseShoot } from "./shoot-commands.js";
import { type PathCliReport, describeCliPackage, inspectPathCli, label } from "./path-cli.js";
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

/** This CLI's package, and where it comes from (see {@link describeCliPackage}). */
const SELF = describeCliPackage(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Release version, used in `--version` and the handshake client id: the
 * desktop app's when the CLI ships inside it, else the CLI package's.
 */
export const CLI_VERSION: string = SELF.version ?? (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const USAGE = `Usage: frameshell <command> [options]

Commands:
  init [dir] [--name <name>] [--no-skill] [--kind video|image]
                               Scaffold a project in dir (default: current directory) with the agent skill
                               in .claude/skills/frameshell/, AGENTS.md, GEMINI.md and .claude/settings.json
                               (asked first on a terminal; --no-skill: none). --kind image: a still picture,
                               the first frame, exported with \`frame\`; video tracks are its layers
  status [--json]              Show daemon, the enclosing project, jobs, rejected edits, open transactions
  doctor [--install] [--json]  Check binaries, encoders and the frameshell on PATH; exit 1 on problems.
                               --install downloads missing managed binaries first
  import <file…> [--link] [--wait]
                               Copy files into assets/ and queue proxies, waveforms, thumbnails.
                               --link hard-links instead of copying; --wait blocks until done
                               (exit 1 if any failed). Progress: \`frameshell status\`
  gc [--dry-run]               Delete regenerable files under .frameshell/ nothing uses any more (derived media
                               of deleted or changed assets, unused clip renders, stale temps).
                               --dry-run lists them without deleting
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
  transcribe --speakers <asset> [--people n]
                               Find who says each word of the asset's transcript (speaker diarization,
                               local): speaker ids on its words, names in its speakers list. --people:
                               how many talk, when known. First run downloads the engine (about 95 MB)
  render [--preset p] [--out file] [--timeline id]
                               Export a timeline to video (default preset: export.defaultPreset,
                               else youtube-1080p; default file: exports/<timeline>-<preset>.mp4).
                               Waits for the render job, printing progress; exit 1 if it fails
  frame --at <s> --out <file> [--timeline id] [--preset p] [--format png|jpg|webp] [--quality 1-100]
                               Write the frame showing at <s> seconds as an image, format from the
                               extension of <file> unless --format (project resolution,
                               or the preset's)
  inspect --at <s> (--point <x,y> | --px <X,Y>) [--timeline id] [--segment]
                               What a point of the frame shows: the clips under it (topmost first) and, in a
                               generated clip, the element painting it (selector, text, box, styles). --point
                               takes fractions of the frame (0.71,0.14), --px project pixels (1363,151). --segment: on a photo
                               of an image project, also write three mask PNGs of the part under the point
                               (smallest first) to .frameshell/context/ (first use downloads a ~45 MB model)
  proposal status              Review mode (the person's switch) and the open proposal waiting for their review
  proposal wait [--timeout s]  Block until the open proposal is decided (default 300 s, max 3600). Exit code:
                               0 accepted (or nothing to wait for), 3 rejected, 4 stale, 5 aborted, 6 still
                               pending after the timeout (run it again)
  proposal diff [--tx id]      Clips the open proposal adds, removes, moves or changes, per timeline
${PEOPLE_USAGE}${SHOOT_USAGE}  script outline <file>        Scenes (\`## \` headings) of a Markdown script: anchors for --script-ref,
                               linked clips, frontmatter (title, target_duration, aspect)
  script check <file>          Check a shoot script (\`shoot: true\`): scenes, lines with speaker, spoken
                               words and cues, speakers vs people.json, stale source, warnings
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

const BUILTINS = new Set(["init", "status", "doctor", "import", "gc", "plugin", "transcribe", "render", "frame", "inspect", "script", "proposal", "people", "shoot", ...TIMELINE_COMMANDS]);

/** Flags every command accepts. */
export const GLOBAL_FLAGS = ["json", "trust", "help", "version"] as const;

/** Options the parser knows that no timeline command takes (the timeline ones are in `TIMELINE_OPTIONS`). */
const NON_TIMELINE_FLAGS = ["install", "link", "wait", "dry-run", "no-skill", "format", "quality", "provider", "model", "language", "verify", "speakers", "people", "point", "px", "timeout", "tx", "angle", "face", "on-screen", "onscreen", "reject", "person", "segment", "scene", "recorded-at", "undo", "restore"] as const;

/** Flags each built-in, non-timeline command takes besides {@link GLOBAL_FLAGS}; enforced when parsing. */
const BUILTIN_FLAGS: Record<string, readonly string[]> = {
  init: ["name", "no-skill", "kind"],
  status: [],
  doctor: ["install"],
  import: ["link", "wait"],
  gc: ["dry-run"],
  "plugin install": [],
  "plugin remove": [],
  "plugin list": [],
  transcribe: ["verify", "speakers", "people", "timeline", "provider", "model", "language"],
  render: ["preset", "out", "timeline"],
  frame: ["at", "out", "timeline", "preset", "format", "quality"],
  inspect: ["at", "point", "px", "timeline", "segment"],
  "script outline": [],
  "script check": [],
  "proposal status": [],
  "proposal wait": ["timeout"],
  "proposal diff": ["tx"],
  ...PEOPLE_FLAGS,
  ...SHOOT_FLAGS,
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
  | { kind: "init"; dir: string | undefined; name: string | undefined; skill: false | undefined; projectKind?: "video" | "image" }
  | { kind: "status" }
  | { kind: "doctor"; install: boolean }
  | { kind: "import"; files: string[]; link: boolean; wait: boolean }
  | { kind: "gc"; dryRun: boolean }
  | { kind: "plugin.install"; spec: string }
  | { kind: "plugin.remove"; name: string }
  | { kind: "plugin.list" }
  | { kind: "plugin.run"; plugin: string; command: string; args: string[] }
  | { kind: "transcribe"; asset: string; provider?: string; model?: string; language?: string }
  | { kind: "transcribe.verify"; export: string; timeline?: string; provider?: string; model?: string; language?: string }
  | { kind: "transcribe.speakers"; asset: string; speakers?: number }
  | { kind: "render"; timeline?: string; preset?: string; out?: string }
  | { kind: "frame"; at: number; out: string; timeline?: string; preset?: string; format?: FrameFormat; quality?: number }
  | { kind: "inspect"; at: number; point: { x: number; y: number } | null; px: { x: number; y: number } | null; timeline?: string; segment: boolean }
  | { kind: "script.outline"; file: string }
  | { kind: "script.check"; file: string }
  | { kind: "proposal.status" }
  | { kind: "proposal.wait"; timeout?: number }
  | { kind: "proposal.diff"; tx?: string }
  | PeopleInvocation
  | ShootInvocation
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
          "dry-run": { type: "boolean", default: false },
          name: { type: "string", multiple: true },
          "no-skill": { type: "boolean", default: false },
          kind: { type: "string" },
          format: { type: "string" },
          quality: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          language: { type: "string" },
          verify: { type: "string" },
          speakers: { type: "string" },
          people: { type: "string" },
          preset: { type: "string" },
          point: { type: "string" },
          px: { type: "string" },
          segment: { type: "boolean", default: false },
          timeout: { type: "string" },
          tx: { type: "string" },
          angle: { type: "string" },
          face: { type: "string" },
          "on-screen": { type: "boolean", default: false },
          onscreen: { type: "boolean", default: false },
          reject: { type: "boolean", default: false },
          person: { type: "string" },
          scene: { type: "string" },
          "recorded-at": { type: "string" },
          undo: { type: "boolean", default: false },
          restore: { type: "boolean", default: false },
          help: { type: "boolean", default: false },
          version: { type: "boolean", default: false },
        },
      });
    } catch (error) {
      io.stderr(`${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    const { positionals } = parsed;
    // Only `multicam create` and `multicam gallery` take `--name` several times (one per angle); elsewhere it is one string.
    const perAngle = positionals[0] === "multicam" && (positionals[1] === "create" || positionals[1] === "gallery");
    const names = parsed.values.name;
    if (!perAngle && names !== undefined && names.length > 1) {
      io.stderr(`--name was given ${names.length} times; \`frameshell ${positionals.slice(0, 2).join(" ")}\` takes one.\n\n${USAGE}`);
      return 2;
    }
    const values = { ...parsed.values, name: perAngle ? names : names?.[0] };
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
      builtin = TIMELINE_COMMANDS.has(positionals[0]!) ? parseTimelineCommand(positionals, values) : parseBuiltin(positionals, values as Parameters<typeof parseBuiltin>[1]);
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
  const key = command === "plugin" || command === "script" || command === "proposal" || command === "people" || command === "shoot" ? `${command} ${sub ?? ""}` : command!;
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
    kind?: string | undefined;
    format?: string | undefined;
    quality?: string | undefined;
    install: boolean;
    link: boolean;
    wait: boolean;
    "dry-run": boolean;
    provider?: string | undefined;
    model?: string | undefined;
    language?: string | undefined;
    verify?: string | undefined;
    speakers?: string | undefined;
    people?: string | undefined;
    preset?: string | undefined;
    timeline?: string | undefined;
    out?: string | undefined;
    at?: string | undefined;
    point?: string | undefined;
    px?: string | undefined;
    timeout?: string | undefined;
    tx?: string | undefined;
    speaker?: string | undefined;
    angle?: string | undefined;
    face?: string | undefined;
    "on-screen"?: boolean | undefined;
    onscreen?: boolean | undefined;
    reject?: boolean | undefined;
    person?: string | undefined;
    segment?: boolean | undefined;
    scene?: string | undefined;
    "recorded-at"?: string | undefined;
    undo?: boolean | undefined;
    restore?: boolean | undefined;
  },
): Invocation | null {
  const [command, ...rest] = positionals;
  if (command === "people") return parsePeople(rest, options);
  if (command === "shoot") return parseShoot(rest, options);
  if (command === "inspect") {
    if (rest.length > 0) return null;
    const at = Number(options.at);
    if (options.at === undefined || options.at.trim() === "" || !Number.isFinite(at) || at < 0) {
      throw new UsageError("`frameshell inspect` needs --at <seconds> (a number >= 0), e.g. --at 12.5.");
    }
    if ((options.point === undefined) === (options.px === undefined)) {
      throw new UsageError("`frameshell inspect` needs one of --point <x,y> (fractions of the frame, e.g. 0.71,0.14) or --px <X,Y> (project pixels).");
    }
    const pair = (flag: "point" | "px", text: string) => {
      const parts = text.split(",").map((part) => Number(part.trim()));
      if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0) || (flag === "point" && parts.some((n) => n > 1))) {
        throw new UsageError(`--${flag} takes two numbers x,y${flag === "point" ? " from 0 to 1" : " >= 0"}, e.g. --${flag} ${flag === "point" ? "0.71,0.14" : "1363,151"}.`);
      }
      return { x: parts[0]!, y: parts[1]! };
    };
    return {
      kind: "inspect",
      at,
      point: options.point !== undefined ? pair("point", options.point) : null,
      px: options.px !== undefined ? pair("px", options.px) : null,
      ...(options.timeline ? { timeline: options.timeline } : {}),
      segment: options.segment === true,
    };
  }
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
    const { format } = options;
    if (format !== undefined && format !== "png" && format !== "jpg" && format !== "webp") {
      throw new UsageError(`--format: expected png, jpg or webp, got "${format}".`);
    }
    const quality = options.quality === undefined ? undefined : Number(options.quality);
    if (quality !== undefined && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
      throw new UsageError("--quality: expected an integer from 1 to 100.");
    }
    return { kind: "frame", at, out, ...common, ...(format ? { format } : {}), ...(quality !== undefined ? { quality } : {}) };
  }
  if (command === "transcribe") {
    const { provider, model, language } = options;
    if (options.speakers !== undefined) {
      if (rest.length > 0) throw new UsageError("`frameshell transcribe --speakers <asset>` takes the asset as the flag's value, nothing else.");
      if (options.verify !== undefined || provider || model || language || options.timeline) {
        throw new UsageError("`frameshell transcribe --speakers <asset>` takes only --people.");
      }
      const people = options.people === undefined ? undefined : Number(options.people);
      if (people !== undefined && (!Number.isInteger(people) || people < 1 || people > 32)) {
        throw new UsageError(`--people takes how many people talk, a whole number from 1 to 32, got "${options.people}".`);
      }
      return { kind: "transcribe.speakers", asset: options.speakers, ...(people !== undefined ? { speakers: people } : {}) };
    }
    if (options.people !== undefined) throw new UsageError("--people goes with `frameshell transcribe --speakers <asset>`.");
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
  if (command === "proposal") {
    if (rest.length !== 1) return null;
    if (rest[0] === "status") return { kind: "proposal.status" };
    if (rest[0] === "diff") return { kind: "proposal.diff", ...(options.tx ? { tx: options.tx } : {}) };
    if (rest[0] !== "wait") return null;
    if (options.timeout === undefined) return { kind: "proposal.wait" };
    const timeout = Number(options.timeout);
    if (options.timeout.trim() === "" || !Number.isFinite(timeout) || timeout <= 0 || timeout > PROPOSAL_WAIT_MAX_S) {
      throw new UsageError(`--timeout takes seconds from above 0 to ${PROPOSAL_WAIT_MAX_S}, e.g. --timeout 120.`);
    }
    return { kind: "proposal.wait", timeout };
  }
  if (command === "script") {
    if (rest.length !== 2) return null;
    if (rest[0] === "outline") return { kind: "script.outline", file: rest[1]! };
    if (rest[0] === "check") return { kind: "script.check", file: rest[1]! };
    return null;
  }
  if (command === "init" && rest.length <= 1) {
    const projectKind = options.kind;
    if (projectKind !== undefined && projectKind !== "video" && projectKind !== "image") {
      throw new UsageError(`--kind: expected video or image, got "${projectKind}".`);
    }
    return { kind: "init", dir: rest[0], name: options.name, skill: options["no-skill"] ? false : undefined, ...(projectKind ? { projectKind } : {}) };
  }
  if (command === "status" && rest.length === 0) return { kind: "status" };
  if (command === "doctor" && rest.length === 0) return { kind: "doctor", install: options.install };
  if (command === "import" && rest.length > 0) return { kind: "import", files: rest, link: options.link, wait: options.wait };
  if (command === "gc" && rest.length === 0) return { kind: "gc", dryRun: options["dry-run"] };
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
      const result = await conn.request("project.init", {
        dir,
        agentSkill,
        ...(inv.name ? { name: inv.name } : {}),
        ...(inv.projectKind ? { kind: inv.projectKind } : {}),
      });
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
      // Which `frameshell` this shell runs: only the CLI sees the caller's PATH. Advice, never a problem.
      const command = inspectPathCli(SELF, process.env);
      return flags.json ? json({ ...report, command }) : formatDoctor(report, command);
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
    case "gc": {
      const result = await conn.request("gc", { cwd, dryRun: inv.dryRun });
      return flags.json ? json(result) : formatGc(result);
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
    case "script.check": {
      const result = await conn.request("script.check", { cwd, file: inv.file });
      return flags.json ? json(result) : formatCheck(result);
    }
    case "proposal.status": {
      const result = await conn.request("proposal.status", { cwd });
      return flags.json ? json(result) : formatProposalStatus(result);
    }
    case "proposal.wait": {
      const result = await conn.request("proposal.wait", { cwd, ...(inv.timeout !== undefined ? { timeout: inv.timeout } : {}) });
      outcome.code = PROPOSAL_EXIT_CODES[result.outcome];
      return flags.json ? json(result) : formatProposalWait(result);
    }
    case "people.list":
    case "people.add":
    case "people.rename":
    case "people.remove":
    case "people.link":
    case "people.unlink":
    case "people.scan":
      return executePeople(conn, inv, cwd, flags.json, flags.json ? undefined : progressPrinter(io));
    case "shoot.status":
    case "shoot.add":
    case "shoot.accept":
    case "shoot.choose":
    case "shoot.discard":
      return executeShoot(conn, inv, cwd, flags.json);
    case "people.ranges":
      return executePeople(conn, inv, cwd, flags.json);
    case "people.suggest":
    case "people.confirm":
      return executePeople(conn, inv, cwd, flags.json, flags.json ? undefined : progressPrinter(io));
    case "proposal.diff": {
      const result = await conn.request("proposal.diff", { cwd, ...(inv.tx ? { tx: inv.tx } : {}) });
      return flags.json ? json(result) : formatProposalDiff(result);
    }
    case "transcribe.speakers": {
      const result = await conn.request(
        "transcribe.speakers",
        { cwd, asset: inv.asset, ...(inv.speakers !== undefined ? { speakers: inv.speakers } : {}) },
        flags.json ? {} : { onProgress: progressPrinter(io) },
      );
      return flags.json ? json(result) : formatSpeakers(result);
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
      const long = inv.method === "multicam.faces" && !flags.json;
      return executeTimeline(conn, inv, cwd, flags.json, long ? progressPrinter(io) : undefined);
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
    case "inspect": {
      const where = inv.point ? { ...inv.point, unit: "fraction" as const } : { ...inv.px!, unit: "pixel" as const };
      const result = await conn.request(
        "inspect.point",
        { cwd, ...(inv.timeline ? { timeline: inv.timeline } : {}), at: inv.at, ...where, ...(inv.segment ? { segment: true } : {}) },
        flags.json || !inv.segment ? {} : { onProgress: progressPrinter(io) },
      );
      return flags.json ? json(result) : describePoint(result);
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

/** `frameshell inspect` for people: the layers under the point, then the element and its parents. */
function describePoint(result: MethodResult<"inspect.point">): string {
  const lines = [`Point ${result.x},${result.y} (${result.pixel.x},${result.pixel.y} px) at ${result.at} s (frame ${result.frame}) of ${result.timeline}`];
  if (result.layers.length === 0) lines.push("  black: no clip there");
  for (const layer of result.layers) {
    const note = layer.clip === result.target ? "seen" : layer.paints ? "under" : "transparent there";
    lines.push(`  ${layer.clip} ${layer.type} (${note})`);
  }
  const [element, ...parents] = result.elements;
  if (element) {
    const file = element.adapter?.["source"];
    const components = element.adapter?.["components"];
    lines.push(`Element of ${result.target}: ${element.selector}${element.text ? ` "${element.text}"` : ""}`);
    lines.push(`  <${element.tag}> ${element.box.width}x${element.box.height} at ${element.box.x},${element.box.y} px`);
    if (typeof file === "string") lines.push(`  file ${file}${element.generated ? " (created by a script: not in this file)" : ""}`);
    if (Array.isArray(components) && components.length > 0) lines.push(`  react ${components.join(" > ")}`);
    const styles = Object.entries(element.styles).filter(([, value]) => value && value !== "none" && value !== "normal");
    if (styles.length > 0) lines.push(`  ${styles.map(([key, value]) => `${key}: ${value}`).join("; ")}`);
    if (parents.length > 0) lines.push(`  inside ${parents.map((parent) => parent.selector.split(" > ").at(-1)).join(" < ")}`);
  } else if (result.unavailable) {
    lines.push(`No element: ${result.unavailable}`);
  }
  if (result.segment) {
    const { asset, size, model, chosen, masks } = result.segment;
    lines.push(`Segments of ${asset} (${size.width}x${size.height} px, ${model}), smallest first:`);
    for (const [index, mask] of masks.entries()) {
      const [x, y, w, h] = mask.bbox;
      lines.push(`  ${mask.mask} bbox ${x},${y} ${w}x${h} px (${Math.round(mask.area * 100)} %) score ${mask.score.toFixed(2)}${index === chosen ? " (chosen)" : ""}`);
    }
  } else if (result.segmentUnavailable) {
    lines.push(`Not segmented: ${result.segmentUnavailable}`);
  }
  return `${lines.join("\n")}\n`;
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
      "this project's CLI, history and review loop. AGENTS.md and GEMINI.md point other agents at it, and " +
      ".claude/settings.json lets Claude Code run frameshell commands without asking. [Y/n] ",
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

function formatGc(result: GcResult): string {
  const verb = result.dryRun ? "Would delete" : "Deleted";
  const lines = result.removed.map((entry) => `  ${entry.path}  ${entry.kind} · ${formatBytes(entry.bytes)}`);
  const head =
    result.removed.length === 0
      ? `Nothing to delete in ${result.dir}/.frameshell`
      : `${verb} ${result.removed.length} item(s), ${formatBytes(result.bytes)}:`;
  const forgotten =
    result.forgotten.length > 0 ? [`${result.dryRun ? "Would forget" : "Forgot"} index entries of vanished files: ${result.forgotten.join(", ")}`] : [];
  const skipped = result.skipped.map((skip) => `Kept ${skip.area}: ${skip.reason}`);
  return `${[head, ...lines, ...forgotten, ...skipped].join("\n")}\n`;
}

/** `1.5 MB`-style size, base 1024. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
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
  if (result.recoveredWords > 0) lines.push(`  recovered ${result.recoveredWords} word${result.recoveredWords === 1 ? "" : "s"} hidden in long words`);
  if (result.speechInside.length > 0) {
    lines.push(`  warning: ${result.speechInside.join(", ")} hide${result.speechInside.length === 1 ? "s" : ""} untranscribed speech; never cut inside`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSpeakers(result: TranscribeSpeakersResult): string {
  const lines = [`Speakers of ${result.asset} -> ${result.transcript}`, `  ${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"} · ${result.segments} segments · ${result.seconds.toFixed(1)} s`];
  for (const speaker of result.speakers) lines.push(`  ${speaker.id}  ${speaker.name}  ${speaker.words} words, ${speaker.seconds.toFixed(1)} s`);
  if (result.corrections > 0) lines.push(`  kept ${result.corrections} human speaker correction${result.corrections === 1 ? "" : "s"}`);
  if (result.unassigned > 0) lines.push(`  ${result.unassigned} word${result.unassigned === 1 ? "" : "s"} outside any speech segment: no speaker`);
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
    if (scene.wordRange) {
      const placed = scene.span.map(({ timeline, start, end }) => `${timeline} ${start.toFixed(2)}-${end.toFixed(2)} s`);
      lines.push(`    spoken ${scene.wordRange.transcript ? `${scene.wordRange.transcript} ` : ""}${scene.wordRange.from}..${scene.wordRange.to}  ${placed.length > 0 ? placed.join(", ") : "not on a timeline"}`);
    }
  }
  if (outline.unresolved.length > 0) {
    lines.push("Unresolved refs:", ...outline.unresolved.map(({ timeline, clip, scriptRef }) => `  ${timeline}/${clip} -> ${scriptRef}`));
  }
  if (outline.warnings.length > 0) lines.push("Warnings:", ...outline.warnings.map((warning) => `  ${warning}`));
  return `${lines.join("\n")}\n`;
}

function formatCheck(check: ScriptCheckResult): string {
  const { meta, shoot, scenes } = check;
  const header = [
    check.path,
    ...(meta.title !== null ? [`"${meta.title}"`] : []),
    shoot.shoot ? `shoot, follow ${shoot.follow}` : "not a shoot script",
    `${scenes.length} scene${scenes.length === 1 ? "" : "s"}`,
  ].join(" · ");
  const lines = [header];
  if (check.source) {
    const state = !check.source.found ? "not found" : check.source.stale === null ? `hash ${check.source.hash}` : check.source.stale ? "STALE" : "up to date";
    lines.push(`  source ${check.source.path}  ${state}`);
  }
  if (check.speakers.length > 0) {
    const who = check.speakers.map((speaker) => `${speaker.name}${speaker.person ? ` (${speaker.person})` : ""} ${speaker.lines} line${speaker.lines === 1 ? "" : "s"}`);
    lines.push(`  speakers ${who.join(", ")}`);
  }
  for (const scene of scenes) {
    const expected = scene.expected !== null ? `  expected ${scene.expected} s` : "";
    lines.push(`  #${scene.slug}  ${scene.title}  line ${scene.line}  ${scene.words} word${scene.words === 1 ? "" : "s"}${expected}`);
    for (const line of scene.lines) {
      const cues = line.cues.map((cue) => `[${cue.label}${cue.text !== null ? `: ${cue.text}` : ""}]`).join(" ");
      const said = [line.text, cues].filter((part) => part !== "").join("  ");
      lines.push(`    ${String(line.line).padStart(4)}  ${line.speaker !== null ? `${line.speaker}: ` : ""}${said}`);
    }
  }
  lines.push(check.warnings.length > 0 ? "Warnings:" : "Clean: no warnings.", ...check.warnings.map((warning) => `  ${warning}`));
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

/** Exit code of `frameshell proposal wait` per outcome; 1 and 2 stay failure and usage error. */
const PROPOSAL_EXIT_CODES: Record<MethodResult<"proposal.wait">["outcome"], number> = {
  accepted: 0,
  none: 0,
  rejected: 3,
  stale: 4,
  aborted: 5,
  pending: 6,
};

/** `1 operation` / `3 operations`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatProposal(proposal: Proposal): string {
  const label = proposal.label ? ` "${proposal.label}"` : "";
  const what = proposal.state === "building" ? "building (its transaction is open)" : "ready, waiting for the person's review";
  return `${proposal.tx}${label} by ${proposal.author} · ${what} · ${plural(proposal.operations, "operation")} on ${proposal.timelines.join(", ")} · open ${duration(proposal.ageMs)}`;
}

/** Review mode line of `status` and `proposal status`. */
function reviewLine(review: ReviewState): string {
  if (review.proposal) return `Review mode: ${review.enabled ? "on" : "off"} · proposal ${formatProposal(review.proposal)}`;
  return `Review mode: ${review.enabled ? "on: your changes wait as proposals for the person to accept" : "off: your changes apply at once"}`;
}

function formatProposalStatus(result: MethodResult<"proposal.status">): string {
  const lines = [reviewLine(result)];
  if (result.decisions.length > 0) {
    lines.push("Last decisions:");
    for (const d of result.decisions) {
      const conflicts = d.conflicts.length > 0 ? ` (conflicts: ${d.conflicts.join(", ")})` : "";
      lines.push(`  ${d.at}  ${d.tx}${d.label ? ` "${d.label}"` : ""} by ${d.author}: ${d.outcome}${conflicts}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const WAIT_NEXT: Record<MethodResult<"proposal.wait">["outcome"], string> = {
  accepted: "The person accepted it: its changes are in the timeline. Continue.",
  rejected: "The person rejected it: nothing was applied. Ask what to change, or adjust.",
  stale: "The person changed the same clips meanwhile: nothing was applied. Read the timeline again and redo the change.",
  aborted: "Its transaction was aborted: nothing was applied.",
  pending: "Still waiting for the person. Run `frameshell proposal wait` again.",
  none: "No proposal is open and none was decided yet. Nothing to wait for.",
};

function formatProposalWait(result: MethodResult<"proposal.wait">): string {
  const head = result.tx === null ? "No proposal" : `Proposal ${result.tx}${result.label ? ` "${result.label}"` : ""}`;
  const conflicts = result.conflicts.length > 0 ? ` (conflicts: ${result.conflicts.join(", ")})` : "";
  return `${head}: ${result.outcome}${conflicts}\n${WAIT_NEXT[result.outcome]}\n`;
}

function formatProposalDiff(result: MethodResult<"proposal.diff">): string {
  if (result.tx === null || result.timelines.length === 0) return "No proposal is open.\n";
  const place = (at: { track: string; start: number; end: number | null } | null) => (at ? `${at.track} ${at.start}–${at.end ?? "?"} s` : "");
  const lines = [`Proposal ${result.tx}:`];
  for (const timeline of result.timelines) {
    lines.push(`Timeline ${timeline.timeline} · ${plural(timeline.clips.length, "clip")}`);
    for (const clip of timeline.clips) {
      const move = clip.before && clip.after ? `${place(clip.before)} -> ${place(clip.after)}` : place(clip.before ?? clip.after);
      lines.push(`  ${clip.change.padEnd(7)} ${clip.clip}  ${move}`);
    }
  }
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
  if (status.synced) {
    lines.push(
      `Warning: the project is in a ${status.synced.service} folder (${status.synced.root}). Its .frameshell/ ` +
        "(proxies, renders, history, often several GB) syncs too, and syncing can corrupt the history. " +
        "Move the project out of that folder.",
    );
  }
  if (status.review?.enabled || status.review?.proposal) lines.push(reviewLine(status.review));
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

function formatDoctor(report: DoctorResult, command: PathCliReport): string {
  const lines = [`Platform ${report.platform} · data dir ${report.dataDir}`, "", "Command:"];
  lines.push(`  this CLI      ${label(command.self)}`);
  if (command.path) {
    const target = command.target && command.target !== command.path ? ` → ${command.target}` : "";
    const runs = command.same ? "this CLI" : command.cli ? label(command.cli) : "unknown";
    lines.push(`  on PATH       ${command.path}${target} · ${runs}`);
  } else {
    lines.push("  on PATH       none");
  }
  for (const note of command.notes) lines.push(`  note: ${note}`);
  lines.push("", "Binaries:");
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
