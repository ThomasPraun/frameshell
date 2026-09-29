import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Wire protocol version. Client and daemon must match exactly; bump on any
 * breaking change to a method, param, result or error code.
 */
export const PROTOCOL_VERSION = 2;

/**
 * One daemon method as declared in {@link methods}.
 *
 * `params` validates at runtime in the daemon and generates tool input schemas
 * (MCP, CLI); `result` documents and types the reply. Both must be JSON
 * Schema-representable: refinements are enforced at runtime but dropped from
 * generated schemas, so repeat them in `.describe()` text.
 */
export interface MethodSpec<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  /** Model-facing: what the method does, units, when to call it. Becomes the MCP tool description. */
  readonly description: string;
  /** Params object. Use `z.strictObject` so misspelled fields fail instead of being ignored. */
  readonly params: P;
  readonly result: R;
  /** Connection plumbing, not a project operation: never exposed as an MCP tool or CLI command. */
  readonly internal?: boolean;
}

/** Absolute path on the daemon's machine; relative paths would resolve against the daemon's cwd, not the caller's. */
const AbsolutePath = z.string().refine(isAbsolute, { message: "must be an absolute path" });

const DaemonIdentitySchema = z.object({
  protocolVersion: z.int().describe("Wire protocol version the daemon speaks."),
  daemonVersion: z.string().describe("frameshelld package version."),
  pid: z.int().describe("Daemon process id."),
});

const ProjectSummarySchema = z.object({
  dir: z.string().describe("Absolute directory holding `frameshell.json`."),
  name: z.string().describe("Project display name."),
  schemaVersion: z.int().describe("On-disk schema version of the project files."),
});

const BinaryReportSchema = z.object({
  name: z.string().describe("Executable name without extension, e.g. `ffmpeg`."),
  package: z.string().describe("Managed package that ships it, e.g. `ffmpeg` (also ships `ffprobe`)."),
  source: z
    .enum(["managed", "project", "global"])
    .describe(
      "`managed`: pinned download under the app data dir. `project` / `global`: path from `binaries` in " +
        "`frameshell.json` / the global `config.json`.",
    ),
  path: z.string().nullable().describe("Absolute executable path; null when managed and no build is pinned for this platform."),
  installed: z.boolean().describe("True when the executable exists at `path`."),
  version: z.string().nullable().describe("Version reported by `<name> -version`; null when missing or not runnable."),
  pinned: z
    .object({
      version: z.string(),
      origin: z.string().describe("Who builds it (homepage)."),
      license: z.string().describe("SPDX licence of the build."),
    })
    .nullable()
    .describe("Managed build pinned for this platform; null when none."),
});

const CodecReportSchema = z.object({
  name: z.string().describe("ffmpeg codec implementation name, e.g. `libx264`, `libvpx-vp9`, `h264_nvenc`."),
  kind: z.enum(["encoder", "decoder"]),
  label: z.string().describe("Human label, e.g. `H.264 (NVENC)`."),
  hardware: z.boolean().describe("GPU or OS media engine encoder (VideoToolbox, NVENC, VAAPI)."),
  compiled: z.boolean().describe("Listed by `ffmpeg -encoders` / `-decoders`."),
  works: z
    .boolean()
    .nullable()
    .describe("Hardware encoders only: a one-frame test encode succeeded on this machine. Null when not tested."),
});

/**
 * Whether a project's declared plugins may load (SPEC §6.6). `not-required`:
 * no plugins declared. `unknown`: never decided for this exact plugin list.
 */
const TrustStateSchema = z
  .enum(["not-required", "unknown", "trusted", "denied"])
  .describe(
    "Plugin trust: `not-required` (no plugins declared), `unknown` (never decided for this plugin list), " +
      "`trusted` (plugins load), `denied` (plugins stay off).",
  );

const PinsSchema = z
  .record(z.string(), z.string())
  .describe("Declared plugins from `frameshell.json`: package name to pinned npm spec (exact version or git URL#commit).");

const CwdParam = AbsolutePath.describe(
  "Absolute directory inside the project, e.g. `/home/ana/videos/launch`. The project is found searching upwards.",
);

const PluginInfoSchema = z.object({
  name: z.string().describe("npm package name."),
  pin: z.string().describe("Pinned spec from `frameshell.json`."),
  status: z
    .enum(["loaded", "error", "untrusted"])
    .describe("`loaded`: contributions active. `error`: see `error`. `untrusted`: project not trusted, code not run."),
  version: z.string().nullable().describe("Manifest version; null unless read."),
  apiVersion: z.string().nullable().describe("Plugin API version the manifest targets; null unless read."),
  error: z.string().nullable().describe("Why the plugin did not load; null otherwise."),
  contributes: z
    .object({
      clipTypes: z.array(z.string()),
      transcriptionProviders: z.array(z.string()),
      commands: z.array(z.string()).describe("`<group> <command>`, run as `frameshell <group> <command>`."),
      exportPresets: z.array(z.string()),
      skills: z.array(z.string()).describe("Absolute paths of the plugin's agent skill files."),
    })
    .nullable()
    .describe("Declared contributions; null unless the manifest was read."),
});

const ExportPresetResultSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  plugin: z.string().describe("Package that contributed the preset."),
});

/**
 * Every method frameshelld serves: the single source for client and daemon
 * types, daemon param validation and generated tool schemas.
 * Adding a method = one entry here plus its daemon handler (the compiler
 * enforces the handler).
 */
export const methods = {
  handshake: {
    description:
      "First request on every connection; other methods fail until it succeeds. " +
      "Fails with IncompatibleProtocol when protocol versions differ.",
    internal: true,
    // Loose on purpose: fields added by future clients must reach the version check, not fail validation.
    params: z.object({
      protocolVersion: z.int().positive().describe("Wire protocol version the client speaks."),
      client: z.string().min(1).describe("Free-form client id for logs and history attribution, e.g. `cli/0.1.0`."),
      session: z
        .string()
        .min(1)
        .optional()
        .describe("Terminal session the caller runs in (`FRAMESHELL_SESSION`); attributes its operations to that terminal."),
    }),
    result: DaemonIdentitySchema,
  },
  status: {
    description:
      "Report daemon state and the Frameshell project enclosing a directory, searching upwards from it. " +
      "Opens that project in the daemon. `project` is null when the directory is in no project.",
    params: z.strictObject({
      cwd: AbsolutePath.describe("Absolute directory to resolve the project from, e.g. `/home/ana/videos/launch/assets`."),
    }),
    result: z.object({
      daemon: DaemonIdentitySchema.extend({
        uptimeMs: z.number().describe("Milliseconds since the daemon started."),
        clients: z.int().describe("Connected clients, including the caller."),
        socketPath: z.string().describe("Unix socket path or Windows pipe name the daemon listens on."),
      }),
      project: ProjectSummarySchema.nullable().describe("Project enclosing `cwd`; null when none."),
      trust: z
        .object({ state: TrustStateSchema, plugins: PinsSchema })
        .nullable()
        .describe("Plugin trust of `project`; null when there is no project."),
      openProjects: z.array(ProjectSummarySchema).describe("Every project the daemon holds open."),
      caller: z
        .object({
          client: z.string().describe("Client id the caller sent in its handshake."),
          session: z
            .string()
            .nullable()
            .describe("Terminal session the caller's operations are attributed to; null outside a Frameshell terminal."),
        })
        .describe("Who the daemon attributes this connection's operations to."),
    }),
  },
  "project.init": {
    description:
      "Create a new Frameshell project: scaffold the directory layout, a default `frameshell.json` " +
      "(1080p, 30 fps, 48 kHz) and an empty `main` timeline, then open it. " +
      "Fails with ProjectExists when the directory already holds `frameshell.json`; never overwrites.",
    params: z.strictObject({
      dir: AbsolutePath.describe("Absolute project directory; created if missing. Example: `/home/ana/videos/launch`."),
      name: z.string().optional().describe("Display name. Defaults to the directory name."),
    }),
    result: z.object({
      project: ProjectSummarySchema,
      created: z
        .array(z.string())
        .describe("Project-relative paths created, `/`-separated; directories end with `/`."),
    }),
  },
  doctor: {
    description:
      "Diagnose native binaries: which ffmpeg/ffprobe will be used (managed download or a `binaries` override " +
      "from the project enclosing `cwd` or the global config), their versions, and which encoders and decoders " +
      "ffmpeg provides (x264, libvpx VP9 encode and decode, VideoToolbox, NVENC, VAAPI; hardware ones are " +
      "test-encoded). `problems` lists what blocks rendering, each with a fix. With `install: true`, missing " +
      "managed binaries are downloaded and checksum-verified first (tens of MB, may take minutes).",
    params: z.strictObject({
      cwd: AbsolutePath.describe("Absolute directory whose enclosing project's `binaries` overrides apply."),
      install: z
        .boolean()
        .default(false)
        .describe("Download missing managed binaries before diagnosing. Default false: report only."),
    }),
    result: z.object({
      platform: z.string().describe("`<os>-<arch>` key used to pick pinned builds, e.g. `darwin-arm64`."),
      dataDir: z.string().describe("App data directory holding managed binaries."),
      binaries: z.array(BinaryReportSchema),
      codecs: z
        .array(CodecReportSchema)
        .describe("Empty when ffmpeg is not installed or not runnable."),
      problems: z.array(z.string()).describe("Actionable issues; empty when everything needed works."),
    }),
  },
  "project.trust": {
    description:
      "Record the user's trust decision for the plugins the enclosing project declares (SPEC §6.6). " +
      "Plugins run with full access to the machine: only send `trust` after the user explicitly agreed. " +
      "Stored per user, keyed by project path and the exact plugin list; a changed list is `unknown` again.",
    params: z.strictObject({
      cwd: CwdParam,
      decision: z.enum(["trust", "deny"]).describe("`trust` loads the plugins; `deny` keeps them off."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      trust: TrustStateSchema,
      plugins: PinsSchema,
    }),
  },
  "plugin.list": {
    description:
      "List the plugins the enclosing project declares, with load status and contributions. " +
      "Loads them first when the project is trusted, reinstalling from the pins if `.frameshell/plugins` is stale.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      trust: TrustStateSchema,
      plugins: z.array(PluginInfoSchema),
    }),
  },
  "plugin.install": {
    description:
      "Install a plugin into the enclosing project and pin it in `frameshell.json`. " +
      "`spec` is `github:<user>/<repo>[#ref]`, a `git+<url>[#ref]` URL, or an npm name `[@scope/]name[@version]`. " +
      "Git sources pin the resolved commit; npm sources pin the exact version. " +
      "Fails with ProjectNotTrusted when the project already declares plugins that are not trusted, " +
      "InvalidPlugin when the package has no valid manifest or targets another plugin API version (nothing is pinned then).",
    params: z.strictObject({
      cwd: CwdParam,
      spec: z.string().min(1).describe("Plugin source, e.g. `github:acme/frameshell-titles` or `@acme/titles@1.2.0`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      name: z.string().describe("Installed package name."),
      pin: z.string().describe("Spec written to `frameshell.json`."),
      plugin: PluginInfoSchema,
    }),
  },
  "plugin.remove": {
    description:
      "Remove a plugin from the enclosing project: unpin it in `frameshell.json` and uninstall it. Fails with PluginNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: z.string().min(1).describe("Package name as listed by `plugin.list`, e.g. `@acme/titles`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      name: z.string(),
      pin: z.string().describe("Pin that was removed."),
    }),
  },
  "plugin.run": {
    description:
      "Run a plugin-contributed command, the same as `frameshell <plugin> <command> [args…]`. " +
      "Fails with ProjectNotTrusted when the project's plugins are not trusted, CommandNotFound (data lists available commands), " +
      "or PluginCommandFailed when the command throws.",
    params: z.strictObject({
      cwd: CwdParam,
      plugin: z.string().min(1).describe("Command group, the first word after `frameshell`, e.g. `hyperframes`."),
      command: z.string().min(1).describe("Command within the group, e.g. `new`."),
      args: z.array(z.string()).default([]).describe("Remaining arguments, verbatim."),
    }),
    result: z.object({
      output: z.string().nullable().describe("Human-readable output; null when the command printed nothing."),
      data: z.unknown().describe("JSON result of the command; null when none."),
    }),
  },
  "export.presets": {
    description: "List the export presets available in the enclosing project, contributed by its trusted plugins.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      presets: z
        .array(ExportPresetResultSchema)
        .describe("Declarative presets: `container`, `video` (codec, width, height…), `audio`, `loudness` (LUFS)."),
    }),
  },
  "file.write": {
    description:
      "Write a UTF-8 text file inside a Frameshell project (scripts, compositions, config), replacing it atomically. " +
      "Missing parent directories are created. `frameshell.json` and `timelines/*.json` must pass schema validation " +
      "or the write is rejected with InvalidProjectFile and the old file kept. " +
      "Fails with OutsideProject for paths in no project, under daemon-owned `.frameshell/` (any letter case), " +
      "resolving outside the project through a symlink, or naming a symlink.",
    params: z.strictObject({
      path: AbsolutePath.describe("Absolute file path inside a project, e.g. `/home/ana/videos/launch/scripts/launch.md`."),
      content: z.string().describe("Full new file content, UTF-8."),
    }),
    result: z.object({
      project: z.string().describe("Absolute root of the project holding the file."),
      path: z.string().describe("Written file, project-relative and `/`-separated."),
    }),
  },
} as const satisfies Record<string, MethodSpec>;

/** Any method name the daemon serves. */
export type MethodName = keyof typeof methods;

/** Params a caller sends for `M` (Zod input: optional fields may be omitted). */
export type MethodParams<M extends MethodName> = z.input<(typeof methods)[M]["params"]>;

/** Params a daemon handler receives for `M`, after validation. */
export type ValidatedParams<M extends MethodName> = z.output<(typeof methods)[M]["params"]>;

/** Result the daemon returns for `M`. */
export type MethodResult<M extends MethodName> = z.output<(typeof methods)[M]["result"]>;

/** Method name to params and result, derived from {@link methods}. */
export type Methods = { [M in MethodName]: { params: MethodParams<M>; result: MethodResult<M> } };

/** `handshake` params. */
export type HandshakeParams = MethodParams<"handshake">;
/** Daemon identity returned by a successful handshake. */
export type HandshakeResult = MethodResult<"handshake">;
/** `status` params. */
export type StatusParams = MethodParams<"status">;
/** Result of `status`. */
export type StatusResult = MethodResult<"status">;
/** `project.init` params. */
export type ProjectInitParams = MethodParams<"project.init">;
/** Result of `project.init`. */
export type ProjectInitResult = MethodResult<"project.init">;
/** `doctor` params. */
export type DoctorParams = MethodParams<"doctor">;
/** Result of `doctor`. */
export type DoctorResult = MethodResult<"doctor">;
/** One binary in a {@link DoctorResult}. */
export type BinaryReport = z.output<typeof BinaryReportSchema>;
/** One encoder or decoder in a {@link DoctorResult}. */
export type CodecReport = z.output<typeof CodecReportSchema>;
/** Plugin trust state of a project. */
export type TrustState = z.output<typeof TrustStateSchema>;
/** One declared plugin as reported by `plugin.list`. */
export type PluginInfo = z.output<typeof PluginInfoSchema>;
/** Declared plugins: package name to pinned spec. */
export type PluginPins = Record<string, string>;
/** `file.write` params. */
export type FileWriteParams = MethodParams<"file.write">;
/** Result of `file.write`. */
export type FileWriteResult = MethodResult<"file.write">;
/** Summary of an open project. */
export type ProjectSummary = z.output<typeof ProjectSummarySchema>;

/** True when `name` is a declared method. Own keys only, so `toString` and friends never match. */
export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}

/**
 * Validate raw params for `method`.
 *
 * Throws {@link RpcError} `InvalidParams` naming every offending field as
 * `params.<path>`; `data.issues` carries `{ path, message }` per issue.
 */
export function parseParams<M extends MethodName>(method: M, params: unknown): ValidatedParams<M> {
  const parsed = (methods[method].params as z.ZodType).safeParse(params);
  if (parsed.success) return parsed.data as ValidatedParams<M>;
  const issues = parsed.error.issues.map(({ path, message }) => ({ path: path.map(String), message }));
  const lines = issues.map(({ path, message }) => `  ${["params", ...path].join(".")}: ${message}`);
  throw new RpcError(ErrorCode.InvalidParams, `Invalid params for \`${method}\`:\n${lines.join("\n")}`, { issues });
}

/** JSON Schema (draft 2020-12) of one method, for tool generation. */
export interface MethodJsonSchema {
  description: string;
  /** See {@link MethodSpec.internal}. */
  internal: boolean;
  /** What callers send: optional and defaulted fields stay optional. */
  params: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** Every method in {@link methods} as JSON Schema, keyed by method name. Input for MCP tool and CLI generation. */
export function methodJsonSchemas(): Record<MethodName, MethodJsonSchema> {
  const entries = Object.entries(methods).map(([name, spec]: [string, MethodSpec]) => [
    name,
    {
      description: spec.description,
      internal: spec.internal ?? false,
      params: z.toJSONSchema(spec.params, { target: "draft-2020-12", io: "input" }),
      result: z.toJSONSchema(spec.result, { target: "draft-2020-12", io: "output" }),
    },
  ]);
  return Object.fromEntries(entries) as Record<MethodName, MethodJsonSchema>;
}

/**
 * JSON-RPC error codes. -32768..-32000 reserved by JSON-RPC 2.0; app codes
 * use -32001 downwards. `data` shape noted per code.
 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  /** data: `{ issues: { path: string[], message }[] }`; `path` is relative to `params`. */
  InvalidParams: -32602,
  InternalError: -32603,
  /** data: `{ clientProtocolVersion, daemonProtocolVersion, daemonVersion }` */
  IncompatibleProtocol: -32001,
  HandshakeRequired: -32002,
  /** data: `{ path }` of the existing `frameshell.json` */
  ProjectExists: -32003,
  /** data: `{ path, details }` */
  InvalidProjectFile: -32004,
  /** data: `{ path, details }` of the global `config.json` */
  InvalidGlobalConfig: -32005,
  /** data: `{ binary, platform }`: no build pinned for this platform and no override. */
  BinaryUnavailable: -32006,
  /** data: `{ binary, path, source }`: override points at a missing file. */
  BinaryNotFound: -32007,
  /** data: `{ binary, url, details }`: download or extraction failed. */
  BinaryInstallFailed: -32008,
  /** data: `{ binary, url, expected, actual }` (SHA-256 hex) */
  BinaryChecksumMismatch: -32009,
  /** data: `{ cwd }` */
  ProjectNotFound: -32010,
  /** data: `{ dir, trust, plugins }` */
  ProjectNotTrusted: -32011,
  /** data: `{ spec }` */
  InvalidPluginSpec: -32012,
  /** data: `{ spec, output }`; `output` is the tail of npm's stderr */
  PluginInstallFailed: -32013,
  /** data: `{ name, details }` */
  InvalidPlugin: -32014,
  /** data: `{ name, installed: string[] }` */
  PluginNotFound: -32015,
  /** data: `{ command, available: string[] }` */
  CommandNotFound: -32016,
  /** data: `{ command, plugin }` */
  PluginCommandFailed: -32017,
  /** data: `{ path }` of the refused file */
  OutsideProject: -32018,
} as const;

/** Error raised by the client when the daemon answers with a JSON-RPC error. */
export class RpcError extends Error {
  override readonly name = "RpcError";

  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
