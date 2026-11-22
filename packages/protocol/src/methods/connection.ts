import { z } from "zod";
import { AgentLabelSchema } from "../agents.js";
import { OpenTransactionSchema } from "../history.js";
import { ReviewStateSchema } from "../proposals.js";
import { OFFICIAL_PLUGIN_KINDS, PLUGIN_NEED_KINDS } from "../official-plugins.js";
import { RejectionRecordSchema } from "../timeline.js";
import {
  type MethodSpec,
  AbsolutePath,
  DaemonIdentitySchema,
  ProjectSummarySchema,
  BinaryReportSchema,
  ManagedDownloadSchema,
  CodecReportSchema,
  EncoderReportSchema,
  MachineProfileSchema,
  TrustStateSchema,
  PinsSchema,
  CwdParam,
  PluginInfoSchema,
  JobSchema,
  CoreSkillStateSchema,
} from "./shared.js";

/** Daemon methods: connection, project setup, skill, trust and plugins. */
export const connectionMethods = {
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
        .describe(
          "Terminal session the caller runs in (`FRAMESHELL_SESSION`, or one the CLI generates per shell); attributes its operations to that terminal.",
        ),
      agent: AgentLabelSchema.nullable()
        .optional()
        .describe(
          "Agent CLI the caller runs under (`FRAMESHELL_AGENT`): its operations are journaled as `agent:<label>:<session>`. " +
            "Null: not an agent, whatever the app detected in the terminal. Absent: the label the app set for the session " +
            "with `session.tag`, if any.",
        ),
    }),
    result: DaemonIdentitySchema,
  },
  "session.tag": {
    description:
      "Tag terminal `session` with the agent CLI running in it (the app detects it from the terminal's foreground " +
      "process), or untag it with null. Operations of that session are then journaled as `agent:<label>:<session>` " +
      "unless its client named an agent itself in the handshake. Tags last while the connection that set them is open.",
    internal: true,
    params: z.strictObject({
      session: z.string().min(1).describe("Terminal session (`FRAMESHELL_SESSION`), e.g. `term-1a2b3c4d`."),
      agent: AgentLabelSchema.nullable().describe("Agent label, e.g. `claude`; null when no agent runs any more."),
    }),
    result: z.object({}),
  },
  "credentials.provide": {
    description:
      "Hand the daemon a secret the app keeps for the person (ADR 0050), or take it back with null. The daemon holds it " +
      "in memory only, as its own environment variable, while the connection that gave it is open. A daemon started " +
      "with the variable already in its environment ignores it: the environment wins.",
    internal: true,
    params: z.strictObject({
      name: z.enum(["OPENAI_API_KEY"]).describe("Which secret: the environment variable it stands for."),
      value: z.string().trim().min(1).max(1000).nullable().describe("The secret; null forgets the one this connection gave."),
    }),
    result: z.object({
      source: z
        .enum(["environment", "app", "none"])
        .describe("Where the daemon now takes the secret from: its own environment, this app, or nowhere."),
    }),
  },
  status: {
    description:
      "Report daemon state and the Frameshell project enclosing a directory, searching upwards from it: its jobs, " +
      "refused direct edits, open transactions and review mode (ADR 0019). Opens that project in the daemon. `project` " +
      "is null when the directory is in no project.",
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
      synced: z
        .object({
          service: z.string().describe("Sync service, e.g. `Dropbox`, `iCloud Drive`, `OneDrive`, `Google Drive`."),
          root: z.string().describe("The service's folder holding the project."),
        })
        .nullable()
        .describe(
          "Set when `project` is inside a folder a cloud service syncs: its `.frameshell/` (proxies, renders, history, " +
            "often several GB) syncs too, and a sync client can corrupt the history journal. Suggest moving the " +
            "project out of it. Null when not, or no project.",
        ),
      openProjects: z.array(ProjectSummarySchema).describe("Every project the daemon holds open."),
      rejections: z
        .array(RejectionRecordSchema)
        .describe(
          "Refused direct edits of `project`'s timeline files still kept under `.frameshell/rejected/` (at most 20, " +
            "newest first), across daemon restarts: the daemon's version was restored and the edit kept at `preserved`. " +
            "Delete a preserved file once handled to drop it from this list. Empty when none or no project.",
        ),
      jobs: z
        .array(JobSchema)
        .describe("Background jobs of `project` in this daemon run, oldest first; empty when there is no project."),
      transactions: z
        .array(OpenTransactionSchema)
        .describe(
          "Explicit transactions still open that changed `project` or nothing yet, from any session, oldest first. " +
            "One left by a closed shell keeps grouping that session's operations: commit or abort it from that " +
            "session. Empty when none or no project.",
        ),
      review: ReviewStateSchema.nullable().describe(
        "Review mode of `project` (ADR 0019), as `proposal.status` reports it; null when there is no project.",
      ),
      skill: CoreSkillStateSchema.extend({
        updated: z.array(z.string()).describe("Files the daemon updated on its own when the project opened, reported once; empty otherwise."),
      })
        .nullable()
        .describe("The project's copy of the agent skill; null when there is no project."),
      caller: z
        .object({
          client: z.string().describe("Client id the caller sent in its handshake."),
          session: z
            .string()
            .nullable()
            .describe("Terminal session the caller's operations are attributed to; null when the client sent none."),
          agent: AgentLabelSchema.nullable().describe(
            "Agent the caller's operations are journaled under now (`agent:<label>:<session>`); null when none.",
          ),
        })
        .describe("Who the daemon attributes this connection's operations to."),
    }),
  },
  "project.init": {
    mutating: true,
    description:
      "Create a new Frameshell project: scaffold the directory layout, a default `frameshell.json` " +
      "(1080p, 30 fps, 48 kHz) and an empty `main` timeline, then open it. Also writes the `frameshell` agent skill " +
      "to `.claude/skills/frameshell/`, where agents such as Claude Code load it (kept when that directory exists), and " +
      "agent files kept when present: `AGENTS.md` and `GEMINI.md` pointing other agents at it, and `.claude/settings.json` " +
      "letting Claude Code run `frameshell` commands and tools without asking. None of these when `agentSkill` is false. " +
      "Fails with ProjectExists when the directory already holds `frameshell.json`; never overwrites.",
    params: z.strictObject({
      dir: AbsolutePath.describe("Absolute project directory; created if missing. Example: `/home/ana/videos/launch`."),
      name: z.string().optional().describe("Display name. Defaults to the directory name."),
      agentSkill: z
        .boolean()
        .default(true)
        .describe("Install the `frameshell` agent skill into `.claude/skills/frameshell/`, plus the agent files. Default true."),
      like: AbsolutePath.optional().describe(
        "Media file whose format the project takes instead of the defaults: its display size (even), frame rate snapped " +
          "to the nearest standard one, and sample rate. Probed first, downloading ffprobe on first use. Example: " +
          "`/home/ana/Movies/talk.mp4`. With `kind: \"image\"` and a picture file, the project takes the picture's exact " +
          "size. Fails with AssetNotFound when it is not a readable media file.",
      ),
      kind: z
        .enum(["video", "image"])
        .optional()
        .describe(
          "`image` makes an image project (ADR 0017): one still picture, the timeline's first frame, exported with " +
            "`frame` as PNG, JPEG or WebP; its video tracks are layers. Default `video`.",
        ),
      resolution: z
        .strictObject({ width: z.int().positive(), height: z.int().positive() })
        .optional()
        .describe(
          "Frame size of the project, used instead of the default and of the size `like` gives. For a project made from " +
            "an audio file, which has no picture: `{ width: 1080, height: 1920 }` makes it vertical. Example: `{ width: 1920, height: 1080 }`.",
        ),
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
      "test-encoded). `encoders` says which H.264 encoder renders use (VideoToolbox, NVENC or x264: the first " +
      "that encodes 0.2 s of test video here; probed once per machine and cached), and `profile` the machine's " +
      "speed class with the proxy and draft sizes it suits and the disk a master intermediate takes. " +
      "`problems` lists what blocks rendering, each with a fix. With `install: true`, missing " +
      "managed binaries are downloaded and checksum-verified first (tens of MB, may take minutes).",
    params: z.strictObject({
      cwd: AbsolutePath.describe("Absolute directory whose enclosing project's `binaries` overrides apply."),
      install: z
        .boolean()
        .default(false)
        .describe("Download missing managed binaries before diagnosing. Default false: report only."),
      reprobe: z
        .boolean()
        .default(false)
        .describe("Run the encoder test encodes again instead of using the cached answer (after a driver or GPU change)."),
    }),
    result: z.object({
      platform: z.string().describe("`<os>-<arch>` key used to pick pinned builds, e.g. `darwin-arm64`."),
      dataDir: z.string().describe("App data directory holding managed binaries."),
      binaries: z.array(BinaryReportSchema),
      downloads: z
        .array(ManagedDownloadSchema)
        .describe(
          "Managed downloads on disk (packages and models), each with its bytes, biggest first; empty when nothing was downloaded yet. " +
            "One the person no longer wants is freed with `binaries.remove`.",
        ),
      codecs: z
        .array(CodecReportSchema)
        .describe("Empty when ffmpeg is not installed or not runnable."),
      encoders: EncoderReportSchema.nullable().describe("H.264 encoder choice; null when ffmpeg is not installed or not runnable."),
      profile: MachineProfileSchema.describe("Speed class and recommended sizes of this machine."),
      problems: z.array(z.string()).describe("Actionable issues; empty when everything needed works."),
      skill: CoreSkillStateSchema.nullable().describe("The project's copy of the agent skill; null when `cwd` is in no project."),
    }),
  },
  "binaries.remove": {
    mutating: true,
    description:
      "Delete a managed download from this machine to free disk: a binary package (`ffmpeg` also covers ffprobe; " +
      "`whisper-cpp` (its `whisper-cli`), `whisper-server`, `chrome-headless-shell`, `sherpa-onnx`, `onnxruntime-web`, ...) or a pinned model " +
      "(`ggml-large-v3-turbo-q5_0`, ...), every installed version of it. Names and sizes are in `doctor` `downloads`. " +
      "It downloads again the next time something needs it. Machine-wide, not per project. Never touches a `binaries` " +
      "override, a tool Frameshell does not download (Blender) or a model registered with `model.add`. Fails with " +
      "BinaryInUse while it installs, while jobs, a transcription or another request (a frame capture, a clip check) run, or while the operating system keeps its files " +
      "open. Remove only on the person's request: it can mean a large download again. Removing what is not on disk " +
      "succeeds with `removed: false`.",
    params: z.strictObject({
      name: z.string().min(1).describe("Package or model name from `doctor` `downloads`."),
    }),
    result: z.object({
      name: z.string(),
      kind: z.enum(["package", "model"]),
      removed: z.boolean().describe("False when nothing of it was on disk."),
      versions: z.array(z.string()).describe("Version directories deleted."),
      bytes: z.number().describe("Bytes freed."),
    }),
  },
  "skill.update": {
    mutating: true,
    description:
      "Bring the project's copy of the core agent skill (`.claude/skills/frameshell/`) to this Frameshell's version. " +
      "An unedited older copy is also updated on its own when the project opens. An edited copy is left alone unless " +
      "`force`, which replaces Frameshell's files; files someone added to the folder always stay. An absent copy is " +
      "written again. Fails with ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      force: z.boolean().default(false).describe("Replace Frameshell's files even when edited."),
    }),
    result: CoreSkillStateSchema.extend({
      written: z.array(z.string()).describe("Files written, relative to `dir`."),
      removed: z.array(z.string()).describe("Files Frameshell no longer ships, removed because unedited."),
    }),
  },
  "project.trust": {
    mutating: true,
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
  "plugin.catalog": {
    description:
      "The official Frameshell plugins, each with what it is for, what it needs from the person (their own Blender, " +
      "their own OpenAI API key, a Remotion project), whether it is paid or sends data off the machine, and what it " +
      "downloads on first use with the size for this machine and whether that is already on disk. Also whether the " +
      "enclosing project has it installed, its load status as `plugin.list` reports it and the project's trust state. " +
      "Untrusted plugin code is never run to answer; plugins a trusted project already pins load and sync as " +
      "`plugin.list` does. Nothing is installed or downloaded for it, and no key is ever returned: only whether one is set. These are options, not obligations: offer the ones that fit what the " +
      "person is making, with what they need, what they cost and how much they download, and install nothing " +
      "(`plugin.install`) without the person's yes. Only official plugins are listed; others are installed from the terminal. " +
      "Fails with ProjectNotFound.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      platform: z.string().describe("`<os>-<arch>` the download sizes are for, e.g. `darwin-arm64`."),
      trust: TrustStateSchema,
      plugins: z.array(
        z.object({
          name: z.string().describe("npm package name; `plugin.install` takes it as `spec`."),
          kind: z.enum(OFFICIAL_PLUGIN_KINDS),
          provides: z.array(z.string()).describe("Clip type (`clip-adapter`) or provider id it contributes, e.g. `hyperframes`, `openai`."),
          purpose: z.string().describe("One sentence for a person."),
          need: z.object({
            kind: z.enum(PLUGIN_NEED_KINDS),
            text: z.string().describe("What the person must have or do, in words."),
            met: z
              .boolean()
              .nullable()
              .describe(
                "True when nothing is needed or it was found (Blender as `doctor` finds it, the key's environment variable set in the daemon's environment); " +
                  "false when it was not; null when it cannot be told cheaply (a Remotion project).",
              ),
          }),
          paid: z.boolean().describe("The provider charges per use."),
          cloud: z.boolean().describe("Audio or text leaves the machine."),
          downloads: z.array(
            z.object({
              kind: z.enum(["binary", "model"]),
              id: z.string().describe("Binary package or model id as `doctor` and `model.list` name them."),
              what: z.string(),
              bytes: z.int().nullable().describe("Download size for this machine's platform; null when no build is pinned for it."),
              onDisk: z.boolean().describe("Already downloaded: using the plugin will not download it again."),
            }),
          ),
          downloadBytes: z.int().describe("Sum of `bytes` of the downloads not yet on disk: what first use would fetch (managed downloads; the plugin's own npm package is not counted). whisper-cpp lists the model the project transcribes with: its `transcription.model`, else this machine's default, else the plugin's default (a model registered with `model.add` is on disk)."),
          installed: z.boolean().describe("The project pins it in `frameshell.json`."),
          pin: z.string().nullable().describe("Pinned spec; null when not installed."),
          status: z.enum(["loaded", "error", "untrusted"]).nullable().describe("As `plugin.list`; null when not installed."),
          version: z.string().nullable().describe("Manifest version; null unless read (installed and loaded)."),
          error: z.string().nullable().describe("Why it did not load; null otherwise."),
        }),
      ),
    }),
  },
  "plugin.install": {
    mutating: true,
    description:
      "Install a plugin into the enclosing project and pin it in `frameshell.json`. " +
      "`spec` is `github:<user>/<repo>[#ref]`, a `git+<url>[#ref]` URL, an npm name `[@scope/]name[@version]`, " +
      "or a local tarball made by `npm pack` (`<path>.tgz` or `file:<path>`, relative to `cwd`). " +
      "Git sources pin the resolved commit; npm sources pin the exact version; tarballs pin `file:<path>#sha256=<digest>` " +
      "(always project-relative: a tarball from outside the project is first copied to `vendor/<file>`), and a tarball whose bytes later differ is never installed. The agent skills it ships are linked " +
      "into the project's `.claude/skills/`. " +
      "Fails with InvalidPluginSpec for an unsupported spec or a missing tarball, " +
      "ProjectNotTrusted when the project already declares plugins that are not trusted, " +
      "InvalidPlugin when the package has no valid manifest or targets another plugin API version (nothing is pinned then).",
    params: z.strictObject({
      cwd: CwdParam,
      spec: z.string().min(1).describe("Plugin source, e.g. `github:acme/frameshell-titles`, `@acme/titles@1.2.0` or `./acme-titles-1.2.0.tgz`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      name: z.string().describe("Installed package name."),
      pin: z.string().describe("Spec written to `frameshell.json`."),
      plugin: PluginInfoSchema,
      skills: z
        .array(z.string())
        .describe(
          "Agent skill directories of this plugin linked into the project, project-relative, e.g. `.claude/skills/hyperframes`: " +
            "agents such as Claude Code load them from there. Empty when it ships none.",
        ),
      warnings: z
        .array(z.string())
        .describe("Skills not linked because the project already holds another entry under that name; empty when none."),
    }),
  },
  "plugin.remove": {
    mutating: true,
    description:
      "Remove a plugin from the enclosing project: unpin it in `frameshell.json`, uninstall it and unlink its agent skills. Fails with PluginNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: z.string().min(1).describe("Package name as listed by `plugin.list`, e.g. `@acme/titles`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      name: z.string(),
      pin: z.string().describe("Pin that was removed."),
      skills: z.array(z.string()).describe("Agent skill links removed from the project, project-relative, e.g. `.claude/skills/hyperframes`."),
    }),
  },
  "plugin.run": {
    mutating: true,
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
      failed: z
        .boolean()
        .describe("True when the command ran but reports failure (e.g. `hyperframes check` found blocking errors); the CLI then exits 1. `output` and `data` still carry the details."),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
