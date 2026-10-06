import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentLabelSchema } from "./agents.js";
import { HistoryDiffResultSchema, HistoryResultSchema, OpenTransactionSchema, TransactionInfoSchema } from "./history.js";
import { ScriptMetaSchema, ScriptSceneSchema } from "@frameshell/schema";
import {
  OpIdSchema,
  OperationResultSchema,
  RejectionRecordSchema,
  TimelineIdSchema,
  TimelineProblemSchema,
  TimelineRejectionSchema,
  TimelineViewSchema,
  TrackSummarySchema,
  TxIdSchema,
  operationArgs,
} from "./timeline.js";
import {
  TimeRangeSchema,
  UiCommandSchema,
  UiStateSchema,
  UiViewIdSchema,
  UiViewSchema,
  WordRefSchema,
} from "./ui.js";

/**
 * Wire protocol version. Client and daemon must match exactly; bump on any
 * breaking change to a method, param, result or error code.
 */
export const PROTOCOL_VERSION = 28;

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
  /**
   * Changes project files or daemon state, so a replay must not apply twice:
   * the request may carry an {@link IdempotencyKeySchema} key in
   * `params.idempotencyKey`, split off by {@link parseRequest}.
   */
  readonly mutating?: boolean;
}

/**
 * Client-chosen id of one intended change (e.g. a UUID), sent as
 * `params.idempotencyKey` of a {@link MethodSpec.mutating} method. The daemon
 * remembers recent keys per author: a request repeating one (a retry after a
 * lost reply) gets the first request's result instead of applying again.
 * Kept out of tool schemas: transport plumbing, not an argument.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .describe("Unique per intended change, e.g. a UUID; a replay with the same key returns the first result.");

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
      accelerator: z
        .enum(["metal", "cuda", "vulkan"])
        .nullable()
        .describe("GPU backend of the build; null = CPU only."),
    })
    .nullable()
    .describe(
      "Managed build chosen for this machine; null when none is pinned. GPU builds are chosen when the GPU and " +
        "toolchain are detected, else the CPU build.",
    ),
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

const GcEntrySchema = z.object({
  path: z.string().describe("Project-relative, `/`-separated; a directory ends with `/`."),
  kind: z
    .enum(["proxy", "sidecar", "manifest", "waveform", "thumbnails", "energy", "audio", "clip", "temp"])
    .describe(
      "`proxy`, `sidecar`, `manifest`, `waveform`, `thumbnails`: ingest outputs of content no asset has now (or of an " +
        "older recipe or fps). `energy`: cut-snapping envelope. `audio`: WAV extracted for transcription. `clip`: " +
        "generated-clip render no timeline uses. `temp`: leftover of an interrupted job or transcription.",
    ),
  bytes: z.int().describe("Size on disk; a directory counts its files."),
});

const GcSkipSchema = z.object({
  area: z
    .enum(["media", "clips", "audio", "temp"])
    .describe("What was left alone: derived media, the clip render cache, transcription WAVs, or job temp files."),
  reason: z.string(),
});

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

const JobSchema = z.object({
  id: z.string().describe("Job id, e.g. `j_12`. Unique within one daemon run."),
  kind: z
    .enum(["ingest", "render", "clip"])
    .describe(
      "`ingest`: probe an asset and build its proxy, PCM sidecar, waveform and thumbnails. " +
        "`render`: export a timeline to a video file (`render` method). " +
        "`clip`: render one generated clip (e.g. `hyperframes`) into the clip render cache (`clip.renders`).",
    ),
  project: z.string().describe("Absolute root of the project the job belongs to."),
  asset: z
    .string()
    .describe(
      "Project-relative, `/`-separated input: the asset for `ingest` (e.g. `assets/raw-01.mp4`), the timeline file for " +
        "`render` (e.g. `timelines/main.json`), the composition for `clip` (the clip's `source`, else `<type>:<clip id>`).",
    ),
  output: z
    .string()
    .nullable()
    .describe(
      "`render`: absolute path of the file being written. `clip`: absolute cache entry without extension, " +
        "`.frameshell/cache/clips/<key>` (the render lands at `<key>.webm`, or `<key>.mp4` when opaque). Null for `ingest`.",
    ),
  state: z
    .enum(["queued", "running", "done", "failed", "canceled"])
    .describe("`canceled`: the daemon stopped before the job finished; it is queued again when the project reopens."),
  step: z
    .enum(["hash", "probe", "proxy", "sidecar", "waveform", "thumbnails", "clips", "video", "mux", "render"])
    .nullable()
    .describe(
      "Step running now; null when not running. `ingest`: hash, probe, proxy, sidecar, waveform, thumbnails, in this " +
        "order. `render`: clips (waits for generated clips to finish rendering into the cache), video (segments " +
        "encoded in parallel, loudness measured alongside), then mux (joins segments, normalizes and encodes audio). " +
        "`clip`: render (the adapter plugin renders the composition).",
    ),
  progress: z.number().min(0).max(1).describe("Overall fraction done, 0 to 1."),
  cached: z
    .boolean()
    .nullable()
    .describe("True when unchanged content reused existing outputs and nothing was re-encoded; null until known."),
  error: z.string().nullable().describe("Why the job failed; null otherwise."),
  createdAt: z.string().describe("ISO 8601 time the job was queued."),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

/** Render cache state of one generated clip (SPEC §6.5). */
const ClipRenderSchema = z.object({
  clip: z.string().describe("Clip id, e.g. `c_0100`; inside a nested timeline `<nested clip>/<clip>`, e.g. `c_0200/c_0100`."),
  track: z.string().describe("Track of the timeline that shows the clip (for a nested one, the track of its nested clip)."),
  type: z.string().describe("Adapter clip type, e.g. `hyperframes`."),
  source: z.string().nullable().describe("The clip's composition entry (`source`), project-relative; null when it has none."),
  state: z
    .enum(["ready", "queued", "rendering", "failed", "unavailable"])
    .describe(
      "`ready`: `file` holds the render for the clip as it is now. `queued` / `rendering`: a background `clip` job is " +
        "on it (`job`, `progress`). `failed`: the last render failed (`error`); it is retried when the composition, " +
        "props or project format change, or when an export needs it. `unavailable`: no loaded plugin renders this " +
        "type (not installed, or the project's plugins are not trusted); `error` says which.",
    ),
  key: z
    .string()
    .nullable()
    .describe(
      "Cache key: hash of adapter name and version, clip `source` and `props`, the content of every input file the " +
        "adapter declares, and project fps and resolution. Moving or trimming a clip keeps it. Null when unavailable.",
    ),
  file: z
    .string()
    .nullable()
    .describe(
      "Project-relative cached render, `.frameshell/cache/clips/<key>.webm` (VP9 with alpha) or `.mp4` (opaque); " +
        "null until ready. File time t shows composition time t: the clip plays from its `in`.",
    ),
  hasAlpha: z.boolean().nullable().describe("True when `file` carries alpha (VP9 `alpha_mode=1`); null until ready."),
  width: z.int().nullable().describe("Rendered width in pixels; null until ready."),
  height: z.int().nullable().describe("Rendered height in pixels; null until ready."),
  duration: z.number().nullable().describe("Rendered seconds; null until ready or unknown."),
  job: z.string().nullable().describe("Id of the `clip` job rendering it now (`job.list`, `job.progress`); null otherwise."),
  progress: z.number().min(0).max(1).describe("0..1 of the running render; 1 when ready, 0 otherwise."),
  error: z.string().nullable().describe("Why the render failed or is unavailable; null otherwise."),
});

const ProbeSchema = z.object({
  duration: z.number().nullable().describe("Container duration in seconds; null when unknown (still images)."),
  format: z.string().describe("ffprobe container name, e.g. `mov,mp4,m4a,3gp,3g2,mj2`."),
  video: z
    .object({
      codec: z.string(),
      width: z.int(),
      height: z.int(),
      fps: z.number().nullable().describe("Average frame rate of the source; null for still images."),
      vfr: z.boolean().describe("Variable frame rate source (phones, OBS); the proxy is CFR at project fps anyway."),
      still: z.boolean().describe("Single image, not a moving stream: no proxy is built."),
    })
    .nullable()
    .describe("First video stream; null for audio-only files."),
  audio: z
    .object({ codec: z.string(), sampleRate: z.int(), channels: z.int() })
    .nullable()
    .describe("First audio stream; null when silent."),
});

const AssetSchema = z.object({
  path: z.string().describe("Project-relative, `/`-separated, e.g. `assets/raw-01.mp4`."),
  hash: z.string().nullable().describe("Content hash `sha256:<hex>`; null until hashed. Transcripts carry it as `assetHash`."),
  state: z
    .enum(["pending", "processing", "ready", "failed"])
    .describe("`ready`: every output below exists for the current content. `pending`: not ingested yet."),
  error: z.string().nullable().describe("Why the last ingest failed; null otherwise."),
  media: ProbeSchema.nullable().describe("ffprobe summary; null until probed."),
  proxy: z
    .string()
    .nullable()
    .describe(
      "Project-relative CFR proxy: H.264 `.mp4` at project fps, GOP 15, no B-frames (frame index = sample index), " +
        "faststart, short side at most 540 px; `.webm` (VP9 with its alpha plane, same frame grid and GOP, no audio) when " +
        "the source has alpha. Null for audio-only, still images, or before ingest.",
    ),
  sidecar: z
    .object({
      path: z.string().describe("Project-relative raw PCM file, no header."),
      format: z.literal("s16le"),
      sampleRate: z.int(),
      channels: z.int(),
    })
    .nullable()
    .describe("Preview audio: signed 16-bit little-endian PCM starting at source time 0. Null when the asset has no audio."),
  waveform: z
    .object({
      path: z.string().describe("Project-relative JSON: `{ peaksPerSecond, peaks }`, `peaks` = [min, max] pairs in -128..127."),
      peaksPerSecond: z.int(),
    })
    .nullable(),
  thumbnails: z
    .object({
      dir: z.string().describe("Project-relative directory of JPEGs `0001.jpg`, `0002.jpg`, …"),
      count: z.int(),
      interval: z.number().describe("Seconds between thumbnails; thumbnail n (1-based) shows time (n - 1) * interval."),
    })
    .nullable(),
});

/** Events a connection can subscribe to with `events.subscribe`; each is a {@link notifications} entry. */
const EventNameSchema = z
  .enum(["timeline.changed", "timeline.rejected", "asset.changed", "job.progress"])
  .describe(
    "`timeline.changed`: a timeline file of the project was changed by an operation (any client, or a direct file edit). " +
      "`timeline.rejected`: a direct edit of a timeline file was refused and the daemon's version restored. " +
      "`asset.changed`: an asset's ingest state or derived media changed, or the asset was deleted. " +
      "`job.progress`: a background job (ingest, render, clip) was queued, advanced or finished.",
  );

const EventsParams = z.strictObject({
  cwd: CwdParam,
  events: z.array(EventNameSchema).min(1).describe("Events to (un)subscribe, e.g. `[\"timeline.changed\"]`."),
});

/** A clip in some timeline file, as `script.outline` links it. */
const ClipLocationSchema = z.object({
  timeline: z.string().describe("Timeline id (`timelines/<id>.json`)."),
  clip: z.string().describe("Clip id."),
});

const ExportPresetResultSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  plugin: z.string().nullable().describe("Package that contributed the preset; null for presets built into Frameshell."),
});

const PresetParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Export preset id from `export.presets`, e.g. `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920`. " +
      "Default: `export.defaultPreset` in `frameshell.json`, else `youtube-1080p`.",
  );

/** Where a checked word sits: shared by lost and uncertain words of `transcribe.verify`. */
const VerifiedWordSchema = z.object({
  word: z.string().describe("Word id in the source transcript, e.g. `w_000019`."),
  text: z.string().describe("Word text, with its human edit applied."),
  transcript: z.string().describe("Source transcript file, project-relative."),
  asset: z.string().describe("Source asset, project-relative."),
  track: z.string().describe("Track holding the clip."),
  clip: z.string().describe("Clip that keeps the word, e.g. `c_0002`."),
  at: z.number().describe("Timeline seconds where the word starts (clamped to the clip's first frame when the cut clips its start)."),
  end: z.number().describe("Timeline seconds where the kept part of the word ends."),
  source: z.object({ start: z.number(), end: z.number() }).describe("Word span in source-asset seconds, from the transcript."),
  cut: z
    .object({
      edge: z.enum(["in", "out"]).describe("`in`: the clip's first frame; `out`: its last."),
      at: z.number().describe("Timeline seconds of that edge."),
    })
    .nullable()
    .describe("Nearest cut within 0.5 source seconds of the word, or crossing it; null when the word is away from every cut."),
  clipped: z.boolean().describe("The cut falls inside the word: part of it was removed."),
  confidence: z
    .number()
    .describe("0..1 that this word really is missing from the export: source word confidence times the run's agreement, lower away from cuts."),
});

const LostWordSchema = VerifiedWordSchema.describe(
  "A word kept by the timeline that the cut falls inside (`clipped` is always true), of which nothing was heard in the " +
    "export, not even when the audio around it was re-transcribed alone.",
);

const UncertainWordSchema = VerifiedWordSchema.extend({
  reason: z
    .enum(["repeat", "garbled", "unheard"])
    .describe(
      "`repeat`: missing, but repeats the phrase next to it; whisper can collapse repeated phrases (ADR 0003), so check by ear. " +
        "`garbled`: at a cut, heard as other text (`heardAs`); the cut may have clipped it. " +
        "`unheard`: not heard, but either away from any cut or whole inside its clip (`clipped: false`, also after " +
        "re-transcribing the audio around it): a transcription miss, not a cut; check by ear, never trim for it.",
    ),
  heardAs: z.string().nullable().describe("What was heard in the word's slot for `garbled`; null otherwise."),
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
  status: {
    description:
      "Report daemon state and the Frameshell project enclosing a directory, searching upwards from it: its jobs, " +
      "refused direct edits and open transactions. Opens that project in the daemon. `project` is null when the " +
      "directory is in no project.",
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
      "to `.claude/skills/frameshell/`, where agents such as Claude Code load it, unless `agentSkill` is false or " +
      "that directory exists. " +
      "Fails with ProjectExists when the directory already holds `frameshell.json`; never overwrites.",
    params: z.strictObject({
      dir: AbsolutePath.describe("Absolute project directory; created if missing. Example: `/home/ana/videos/launch`."),
      name: z.string().optional().describe("Display name. Defaults to the directory name."),
      agentSkill: z
        .boolean()
        .default(true)
        .describe("Install the `frameshell` agent skill into `.claude/skills/frameshell/`. Default true."),
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
  "plugin.install": {
    mutating: true,
    description:
      "Install a plugin into the enclosing project and pin it in `frameshell.json`. " +
      "`spec` is `github:<user>/<repo>[#ref]`, a `git+<url>[#ref]` URL, an npm name `[@scope/]name[@version]`, " +
      "or a local tarball made by `npm pack` (`<path>.tgz` or `file:<path>`, relative to `cwd`). " +
      "Git sources pin the resolved commit; npm sources pin the exact version; tarballs pin `file:<path>#sha256=<digest>` " +
      "(path project-relative when inside the project), and a tarball whose bytes later differ is never installed. The agent skills it ships are linked " +
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
    }),
  },
  "export.presets": {
    description:
      "List the export presets available in the enclosing project: the built-in ones (`youtube-1080p`, `youtube-1440p`, " +
      "`vertical-1080x1920`) and those contributed by its trusted plugins.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      presets: z
        .array(ExportPresetResultSchema)
        .describe("Declarative presets: `container`, `video` (codec, width, height…), `audio`, `loudness` (LUFS)."),
    }),
  },
  render: {
    mutating: true,
    description:
      "Export a timeline to a video file (SPEC §3.5) as a background job, and return at once with the job. Video is " +
      "encoded in segments in parallel and joined; audio is mixed in one continuous pass with a 2 ms fade at every cut, " +
      "`atempo` for clip speed, then two-pass loudness normalization to the target (preset `loudness`, else " +
      "`export.loudness` in `frameshell.json`, else -17 LUFS integrated). Follow the job with `job.list` until it is " +
      "`done` (the file exists at `output`) or `failed` (`error` says why), or subscribe to `job.progress`. Renders from the original assets, not " +
      "proxies, and never waits for ingest. Export v1 renders the first video track (media clips, gaps in black) and " +
      "the sound of every video and audio track; `warnings` lists what it skipped (subtitles, transforms). Fails with " +
      "PresetNotFound, ExportUnsupported (empty timeline, clips on a second video track, nested timelines or adapter " +
      "clips), TimelineNotFound, AssetNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      preset: PresetParam,
      out: AbsolutePath.optional().describe(
        "Absolute output file, e.g. `/home/ana/videos/launch/exports/launch.mp4`; its folder is created. " +
          "Default `<project>/exports/<timeline>-<preset>.<container>`. An existing file is replaced when the job finishes.",
      ),
    }),
    result: z.object({
      job: JobSchema,
      output: z.string().describe("Absolute path the file is written to."),
      preset: z.string().describe("Preset id used."),
      timeline: z.string(),
      duration: z.number().describe("Seconds rendered (timeline duration)."),
      width: z.int(),
      height: z.int(),
      fps: z.string().describe("Output frame rate as a rational, e.g. `30/1` or `30000/1001`."),
      loudness: z.number().describe("Integrated loudness target, LUFS."),
      segments: z.int().describe("Video segments encoded in parallel."),
      warnings: z.array(z.string()).describe("Timeline content this export does not render; empty when none."),
    }),
  },
  frame: {
    description:
      "Capture the composited frame showing at timeline time `at` as a PNG, rendered by the export compiler " +
      "(single-frame plan), so it matches `render` and works with the app closed. Size: the preset's when `preset` " +
      "is given, else the project resolution. Fails with InvalidOperation (`at` outside the timeline; data.valid has " +
      "the range), ExportUnsupported, PresetNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`; the frame whose time span holds it is captured."),
      out: AbsolutePath.describe("Absolute PNG path to write, e.g. `/tmp/frame.png`; its folder is created."),
      preset: z.string().min(1).optional().describe("Export preset id whose width and height to use. Default: project resolution."),
    }),
    result: z.object({
      path: z.string().describe("Absolute PNG path written."),
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index captured (0-based, project fps)."),
      at: z.number().describe("Start time of that frame, timeline seconds."),
      clip: z.string().nullable().describe("Clip showing on the first video track; null in a gap (black frame)."),
      width: z.int(),
      height: z.int(),
    }),
  },
  "asset.import": {
    mutating: true,
    description:
      "Bring media files into the enclosing project's `assets/` and queue their ingest (probe, CFR proxy, PCM sidecar, " +
      "waveform, thumbnails). Returns at once; follow progress with `job.list`, `status`, or the `job.progress` and " +
      "`asset.changed` events (`events.subscribe`). Files already under " +
      "`assets/` are not copied. A name clash with different content gets a `-2`, `-3`… suffix. Unchanged content " +
      "reuses cached outputs (job `cached: true`). Fails with ProjectNotFound, or AssetNotFound when a source is not a file.",
    params: z.strictObject({
      cwd: CwdParam,
      files: z
        .array(AbsolutePath)
        .min(1)
        .describe("Absolute paths of the files to import, e.g. `/home/ana/Movies/raw-01.mp4`."),
      mode: z
        .enum(["copy", "link"])
        .default("copy")
        .describe("`copy` (default) duplicates the file. `link` hard-links it, or symlinks across volumes: no copy, but the source must stay."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      imported: z.array(
        z.object({
          source: z.string().describe("Absolute path given."),
          asset: z.string().describe("Project-relative asset path, e.g. `assets/raw-01.mp4`."),
          copied: z.boolean().describe("False when the file already was in `assets/` (as-is or with identical content)."),
          job: JobSchema,
        }),
      ),
    }),
  },
  "asset.list": {
    description:
      "List the files under the enclosing project's `assets/` with their ingest state and derived files: CFR proxy, " +
      "PCM sidecar, waveform, thumbnails (all project-relative, all regenerable under `.frameshell/`).",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      assets: z.array(AssetSchema).describe("Sorted by path."),
    }),
  },
  gc: {
    mutating: true,
    description:
      "Delete regenerable files under `.frameshell/` that nothing uses any more: proxies, PCM sidecars, waveforms, " +
      "thumbnails, energy envelopes and transcription WAVs of assets deleted or changed since (or built for an older " +
      "recipe or another fps), clip renders no timeline's generated clip keys, and temp files of interrupted jobs. " +
      "Keyed by the media index: assets whose content is not known yet are hashed first. Never touches `assets/`, " +
      "project files, history or rejected edits, nor anything a running job uses: the clip cache, transcription WAVs " +
      "and temp files are skipped while jobs or transcriptions run (`skipped` says why). Deleted outputs rebuild on " +
      "demand. `dryRun` lists without deleting.",
    params: z.strictObject({
      cwd: CwdParam,
      dryRun: z.boolean().default(false).describe("Only list what would be deleted. Default false."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      dryRun: z.boolean(),
      removed: z.array(GcEntrySchema).describe("Deleted (or, with `dryRun`, deletable) entries, sorted by path."),
      bytes: z.int().describe("Total size of `removed`."),
      forgotten: z
        .array(z.string())
        .describe("Media index entries of files that no longer exist; dropped from the index unless `dryRun`."),
      skipped: z.array(GcSkipSchema).describe("Areas left alone this run, with why; empty when everything was checked."),
    }),
  },
  "job.list": {
    description:
      "Background jobs of the enclosing project (ingest, render), with state and progress. Jobs keep running after the " +
      "caller disconnects. Poll this until every job you care about is `done` or `failed`, or read it once after " +
      "subscribing to `job.progress` and follow the events instead.",
    params: z.strictObject({
      cwd: CwdParam,
      active: z.boolean().default(false).describe("Only `queued` and `running` jobs. Default false: also finished ones."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      jobs: z.array(JobSchema).describe("Oldest first."),
    }),
  },
  "clip.renders": {
    description:
      "Render cache state of every generated clip (adapter clips such as `hyperframes`) on a timeline (SPEC §6.5). The " +
      "daemon renders these clips in the background whenever one is added, its props change, or a file its composition " +
      "uses changes; unchanged clips reuse the cache. Use it after `clip.add` of a generated clip to learn when its " +
      "render is ready (`state: \"ready\"`), or follow `job.progress` events of kind `clip`. `render` waits for " +
      "pending clip renders itself. A `failed` clip carries the adapter's `error`: fix the composition, then check " +
      "again. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Timeline revision the states refer to."),
      clips: z
        .array(ClipRenderSchema)
        .describe("Generated clips on video tracks, with those of nested timelines where they play (as export flattens them), in track then time order."),
    }),
  },
  transcribe: {
    mutating: true,
    description:
      "Transcribe one asset to word level and write `transcripts/<asset minus extension>.words.json` (SPEC §5.4; " +
      "`transcripts/<asset>.words.json`, extension kept, when another asset with the same base name owns the first " +
      "name): every word with a " +
      "stable id, text, `start`/`end` in source-asset seconds (3 decimals) and confidence, plus the asset's SHA-256, " +
      "provider and model. Audio comes from the asset's PCM sidecar when its ingest is complete (see `asset.list`), " +
        "else from the asset itself; transcription never waits for ingest. Re-transcribing reuses word ids " +
      "where the same word is found again (same text, start within 0.5 s) and keeps the human `edits` of those ids; " +
      "other words get ids never used before in that file. " +
      "The first run downloads the engine and model (whisper.cpp default: 574 MB) and may take minutes; progress " +
      "arrives as `progress` notifications. Fails with ProjectNotTrusted when the project's plugins are not trusted, " +
      "TranscriptionProviderNotFound when no loaded plugin provides the provider, TranscriptionFailed when the engine fails, " +
      "TranscriptNameTaken when both transcript names belong to other assets.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z
        .string()
        .min(1)
        .describe("Media file inside the project, absolute or relative to `cwd`, e.g. `assets/raw-01.mp4`."),
      provider: z
        .string()
        .min(1)
        .optional()
        .describe("Transcription provider id. Default: `transcription.provider` in `frameshell.json`, else `whisper-cpp`."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Provider model id, e.g. `large-v3-turbo-q5_0`. Default: `transcription.model`, else the provider's default."),
      language: z
        .string()
        .min(1)
        .optional()
        .describe("Spoken language code, e.g. `es`. Default: `transcription.language`, else auto-detect."),
    }),
    result: z.object({
      transcript: z.string().describe("Written transcript file, project-relative, e.g. `transcripts/raw-01.words.json`."),
      asset: z.string().describe("Transcribed asset, project-relative."),
      assetHash: z.string().describe("`sha256:<hex>` of the asset bytes."),
      audioSource: z
        .string()
        .describe(
          "Project-relative file the audio was taken from: the asset's PCM sidecar under `.frameshell/proxies/` (same as " +
            "`asset.list` `sidecar.path`), or the asset itself when no complete ingest exists.",
        ),
      provider: z.string(),
      model: z.string(),
      language: z.string().nullable().describe("Language used or detected; null when the provider did not say."),
      device: z.string().nullable().describe("Compute device the engine used (`metal`, `cuda`, `cpu`); null when unknown."),
      words: z.int().describe("Number of words written."),
      reusedIds: z.int().describe("Words that kept the id they had in the previous transcript."),
      keptEdits: z.int().describe("Human edits carried over from the previous transcript."),
      droppedEdits: z.array(z.string()).describe("Ids of human edits dropped because their word was not found again."),
      recoveredWords: z
        .int()
        .describe(
          "Words recovered by re-transcribing alone a word that lasted far too long and held more speech (whisper can " +
            "swallow a repeated phrase into one word); they replace it.",
        ),
      speechInside: z
        .array(z.string())
        .describe(
          "Ids of words still far too long with speech inside after that (`speechInside: true` in the file): they hide " +
            "words the transcript lacks. Never cut inside them; check by ear.",
        ),
      seconds: z.number().describe("Wall time of the whole call, including first-run downloads."),
    }),
  },
  "transcribe.verify": {
    description:
      "Check an exported file for words lost at cuts (SPEC §3.5 step 6): re-transcribe the export and compare it, " +
      "on the timeline clock, with the source transcript words the timeline keeps (each media clip's words inside " +
      "its `in`/`out`, mapped by `start` and `speed`; a word counts as kept when most of it is inside). Writes no " +
      "transcript. A word missing at a cut is re-transcribed again in a short window of export audio around it " +
      "before it is reported. `lost` lists words the cut falls inside (`clipped`) of which nothing was heard either " +
      "time: each with its timeline position, clip and the cut. `uncertain` lists the rest that were not confirmed " +
      "(whisper-collapsed repeats, words at a cut heard as other text, missing words away from cuts or whole inside " +
      "their clip). The alignment ignores case, punctuation, accents, onset jitter, " +
      "split or merged words and close spellings. Clips whose asset has no transcript, or a stale one, are listed in " +
      "`unchecked`: run `transcribe` on them first. Use the same timeline the export was rendered from. Fails with " +
      "AssetNotFound (no such export), TimelineNotFound, and the errors of `transcribe`.",
    params: z.strictObject({
      cwd: CwdParam,
      export: z
        .string()
        .min(1)
        .describe("Exported file, absolute or relative to `cwd`, e.g. `exports/main-youtube-1080p.mp4`."),
      timeline: TimelineIdSchema,
      provider: z
        .string()
        .min(1)
        .optional()
        .describe("Transcription provider id. Default: `transcription.provider` in `frameshell.json`, else `whisper-cpp`."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Provider model id. Default: `transcription.model`, else the model of the source transcripts, else the provider's default."),
      language: z
        .string()
        .min(1)
        .optional()
        .describe("Spoken language code. Default: `transcription.language`, else the source transcripts' language."),
    }),
    result: z.object({
      export: z.string().describe("Absolute path of the checked export."),
      timeline: z.string(),
      revision: z.int().describe("Timeline revision compared against."),
      provider: z.string(),
      model: z.string(),
      language: z.string().nullable(),
      duration: z.object({
        export: z.number().nullable().describe("Seconds of export audio; null when unknown."),
        timeline: z.number().describe("Timeline seconds."),
      }),
      expected: z.int().describe("Source words the timeline keeps, in checked clips."),
      heard: z.int().describe("Of those, words found in the export."),
      lost: z.array(LostWordSchema).describe("Words cut off at a clip edge, by timeline position. Empty = nothing lost."),
      uncertain: z.array(UncertainWordSchema).describe("Words not confirmed but not reported lost, by timeline position."),
      confidence: z
        .number()
        .describe(
          "0..1 agreement of the re-transcription with the sources on words away from cuts. Low (below ~0.8): wrong " +
            "language or timeline, or a noisy export; treat `lost` with care.",
        ),
      unchecked: z
        .array(
          z.object({
            clip: z.string(),
            track: z.string(),
            asset: z.string(),
            reason: z.enum(["no-transcript", "stale-transcript"]).describe("`stale-transcript`: the asset changed after it was transcribed."),
          }),
        )
        .describe("Media clips with sound whose words could not be checked."),
      warnings: z.array(z.string()).describe("Problems that make the report less reliable, e.g. an export shorter or longer than the timeline."),
      seconds: z.number().describe("Wall time of the whole call."),
    }),
  },
  "file.write": {
    mutating: true,
    description:
      "Write a UTF-8 text file inside a Frameshell project (scripts, compositions, config), replacing it atomically. " +
      "Missing parent directories are created. `frameshell.json`, `timelines/*.json` and `transcripts/**/*.words.json` must pass schema validation " +
      "or the write is rejected with InvalidProjectFile and the old file kept. A timeline write is a direct edit (SPEC §6.4): it must " +
      "carry the timeline's current `revision` (else StaleRevision), is checked against timeline rules like any operation, and is " +
      "journaled as a `timeline.patch` operation by author `file` with the revision bumped. " +
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
  "events.subscribe": {
    description:
      "Receive the given events of the enclosing project as notifications on this connection until it closes or " +
      "`events.unsubscribe`. Idempotent. Used by the app and the MCP server to follow changes made by other clients.",
    internal: true,
    params: EventsParams,
    result: z.object({
      dir: z.string().describe("Project root the subscription is scoped to; notifications carry it as `project`."),
      events: z.array(EventNameSchema).describe("Every event this connection now receives for `dir`."),
    }),
  },
  "events.unsubscribe": {
    description: "Stop receiving the given events of the enclosing project on this connection. Unknown subscriptions are ignored.",
    internal: true,
    params: EventsParams,
    result: z.object({
      dir: z.string().describe("Project root."),
      events: z.array(EventNameSchema).describe("Events this connection still receives for `dir`."),
    }),
  },
  "script.outline": {
    description:
      "Outline a Markdown script (SPEC §5.5): frontmatter (`title`, `target_duration` in seconds, `aspect`) and its " +
      "scenes, one per `## ` heading, each with the `ref` to put in a clip's `scriptRef` (`scripts/launch.md#intro`, set " +
      "with `clip.set`) and the clips of every timeline already linked to it. Scenes with empty `clips` still need " +
      "footage or a composition. Top-level `clips` are linked to the whole script (`scriptRef` is the path without " +
      "`#anchor`), e.g. music or a full take; they cover no scene. `unresolved` lists clips pointing into this file at an anchor no scene has (renamed " +
      "or removed heading). Never fails on content: bad frontmatter or duplicate headings become `warnings`. Fails with " +
      "ScriptNotFound (data lists the scripts there are) or OutsideProject.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z
        .string()
        .min(1)
        .describe("Markdown file inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch.md`."),
    }),
    result: z.object({
      path: z.string().describe("Script file, project-relative and `/`-separated."),
      meta: ScriptMetaSchema,
      clips: z
        .array(ClipLocationSchema)
        .describe("Clips whose `scriptRef` is `path` without `#anchor` (the whole script), any timeline; empty when none."),
      scenes: z
        .array(
          ScriptSceneSchema.extend({
            ref: z.string().describe("`scriptRef` value for this scene: `<path>#<slug>`."),
            clips: z.array(ClipLocationSchema).describe("Clips whose `scriptRef` is `ref`, any timeline; empty when none."),
          }),
        )
        .describe("In file order."),
      unresolved: z
        .array(ClipLocationSchema.extend({ scriptRef: z.string() }))
        .describe("Clips referencing this file at an anchor with no scene; fix with `clip.set` `scriptRef`."),
      warnings: z.array(z.string()).describe("Frontmatter problems, duplicate headings, unreadable timelines skipped."),
    }),
  },
  "timeline.show": {
    description:
      "Compact dump of a timeline for agents: revision, project fps, derived duration, and every track with its clips " +
      "(ids, type, asset/source, `start`/`end` in timeline seconds, `in`/`out` in source seconds, speed, audio, transform). " +
      "Read this before editing and use the returned ids. A clip whose nested timeline file is missing or invalid has " +
      "`end: null` and is listed in `problems` with the fix. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: TimelineViewSchema,
  },
  "track.list": {
    description:
      "List a timeline's tracks in stacking order (first video track = bottom layer): id, kind, name, followed track, " +
      "clip count and end time (null while a clip's nested timeline is missing or invalid; see `problems`). " +
      "Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: z.object({
      timeline: z.string(),
      revision: z.int(),
      tracks: z.array(TrackSummarySchema),
      problems: z.array(TimelineProblemSchema),
    }),
  },
  "track.add": {
    mutating: true,
    description:
      "Add a track and return its new id (`t_…`). Example: `{ kind: \"video\", name: \"Camera\" }`; subtitle tracks need " +
      "`follows`: `{ kind: \"subtitles\", follows: \"t_4d5e6f\", style: { preset: \"big-keyword\" } }`. A subtitle track " +
      "copies no words: it shows the transcript words (`transcribe` first) inside each clip of the followed track, on " +
      "the timeline clock, so cuts update it and text corrections go in the transcript's `edits`. Placed on top unless " +
      "`index` is given.",
    params: operationArgs["track.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.set": {
    mutating: true,
    description:
      "Change a track: `name` (any track; null clears it), and for subtitle tracks the followed track (`follows`) and " +
      "`style` (`preset`: `big-keyword` or `plain`; `position`: `top`, `center` or `bottom`; given fields change, others " +
      "stay). Example: `{ track: \"t_4d5e6f\", style: { position: \"top\" } }`. Preview and export use the same style. " +
      "Fails with TrackNotFound or InvalidOperation (style or follows on a clip track, nothing to change).",
    params: operationArgs["track.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.remove": {
    mutating: true,
    description:
      "Remove a track. A track with clips needs `force: true`; a track followed by a subtitle track is refused until that " +
      "subtitle track is removed. Fails with TrackNotFound or InvalidOperation.",
    params: operationArgs["track.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.add": {
    mutating: true,
    description:
      "Place a clip on a video or audio track and return its new id (`c_…`) in `changes.added`. Media example: " +
      "`{ track: \"t_4d5e6f\", asset: \"assets/raw-01.mp4\", start: 0, in: 3.2, out: 15.733 }` (in/out are source seconds, " +
      "default the whole asset; start defaults to right after the track's last clip). Adapter example: " +
      "`{ track, type: \"hyperframes\", source: \"compositions/hyperframes/intro/index.html\", duration: 8, props: {…} }`. " +
      "Times snap to the project frame grid. `ripple: true` inserts: clips at or after `start` on every video and audio " +
      "track (or only `rippleTracks`) move right to make room (e.g. to restore removed words: `{ track, asset, start: 12.4, " +
      "in: 30.1, out: 30.9, ripple: true, snap: true }`). `snap: true` moves media `in`/`out` into audio pauses and reports them in `snaps`. " +
      "Fails with InvalidOperation (overlap, out beyond the source duration, wrong " +
      "track kind, unknown clip type; data says the valid range), AssetNotFound, TrackNotFound.",
    params: operationArgs["clip.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.move": {
    mutating: true,
    description:
      "Move a clip to a new timeline `start` and/or another track of the same kind, keeping its content and length. " +
      "Example: `{ clip: \"c_1a2b3c\", start: 12.5 }`. Refused when it would overlap another clip.",
    params: operationArgs["clip.move"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.trim": {
    mutating: true,
    description:
      "Trim or extend a clip's head and/or tail. By source time: `{ clip, in: 4.0 }` drops source before 4.0 s, the kept " +
      "frames stay where they were on the timeline (start moves right). By timeline time: `{ clip, end: 20.0 }`. Does not " +
      "ripple: use `cut` to close gaps. Media clips with audio: each edge snaps into the nearest audio pause within " +
      "±`snapWindow` (default: project `editing.snapWindow`, else 0.5 s); `snaps` reports requested vs applied and `clean: false` when no pause was in " +
      "reach. `snap: false` trims exactly. `ripple: true` keeps the left edge and moves later clips on every video and " +
      "audio track (or only `rippleTracks`) by the change in length: extend a clip over removed material with `{ clip, out: 18.4, ripple: true }` " +
      "(the inverse of `cut`). Fails with InvalidOperation giving the valid range.",
    params: operationArgs["clip.trim"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.split": {
    mutating: true,
    description:
      "Split a clip in two at timeline time `at`. The left part keeps the id; the right part's new id is in " +
      "`changes.added`. Example: `{ clip: \"c_1a2b3c\", at: 7.5 }`.",
    params: operationArgs["clip.split"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.remove": {
    mutating: true,
    description: "Remove a clip, leaving a gap. To remove a time range and close the gap on every track, use `cut`.",
    params: operationArgs["clip.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.set": {
    mutating: true,
    description:
      "Change clip properties: `speed` (media; end moves), `gain` (dB), `muted`, `transform` (merged field by field), " +
      "`props` (adapter clips; replaced), `scriptRef` (script scene `ref` from `script.outline`, or the script path " +
      "alone for the whole script; null clears). A `scriptRef` whose script or scene does not exist is still stored, with a `warnings` entry naming the scenes " +
      "there are; a `scriptRef` path that is absolute or uses `..` fails with InvalidOperation. " +
      "Example: `{ clip: \"c_1a2b3c\", gain: -6 }`.",
    params: operationArgs["clip.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  cut: {
    mutating: true,
    description:
      "Remove the timeline range [from, to) and close the gap (ripple): clips inside are removed, clips crossing an edge " +
      "are trimmed or split, later clips move left by `to - from`. Applies to every video and audio track unless " +
      "`tracks` is given (cutting only some tracks shifts them against the rest). Example: `{ from: 12.4, to: 13.1 }` " +
      "removes a 0.7 s silence. Where media clips with audio lie under an edge, it snaps into the nearest audio pause " +
      "within ±`snapWindow` (default: project `editing.snapWindow`, else 0.5 s) so no word is clipped; `snaps` reports requested vs applied and " +
      "`clean: false` when no pause was in reach (speech may be clipped there). `snap: false` cuts exactly.",
    params: operationArgs.cut.extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "tx.begin": {
    mutating: true,
    description:
      "Start an explicit transaction for this terminal session: every following operation (any timeline) joins it until " +
      "`tx.commit` or `tx.abort`, so `history` lists them under `label` and `revert` can undo them as one. Without it, " +
      "operations from one session are grouped automatically until an idle gap. The transaction is stored on disk and " +
      "survives a daemon restart. Needs a session: app terminals set `FRAMESHELL_SESSION`, elsewhere the CLI generates " +
      "one per shell. Example: `{ label: \"remove silences\" }`. Pass `autoCommitAfter` when a crash of the caller must " +
      "not leave the transaction open: it is then committed automatically once that many seconds pass without an " +
      "operation of this author. Fails with TransactionState when one is already open.",
    params: z.strictObject({
      label: z.string().min(1).describe("What the transaction does, shown in the History panel, e.g. `remove silences`."),
      autoCommitAfter: z
        .number()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "Seconds without an operation of this author after which the daemon commits the transaction itself, e.g. `15`. " +
            "Default: stays open until `tx.commit` or `tx.abort`.",
        ),
    }),
    result: TransactionInfoSchema,
  },
  "tx.commit": {
    mutating: true,
    description:
      "Close this session's explicit transaction, keeping its changes. `operations` counts them across timelines. " +
      "Fails with TransactionState when none is open.",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      operations: z.int().describe("Operations applied in the transaction."),
    }),
  },
  "tx.abort": {
    mutating: true,
    description:
      "Close this session's explicit transaction and undo its changes: on every timeline it touched, its operations' " +
      "inverses are applied newest first as one `revert` operation inside the transaction. All or nothing: every " +
      "timeline is checked first, and when someone else changed the same tracks or clips since on any of them, nothing " +
      "is undone and it fails with RevertConflict listing each conflicting timeline in `timelines` (transaction stays " +
      "open). Fails with TransactionState when none is open.",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      reverted: z.array(OperationResultSchema).describe("One `revert` operation per timeline the transaction changed."),
    }),
  },
  history: {
    description:
      "List a timeline's journaled operations grouped by transaction, oldest first: op, args, author (`ui`, " +
      "`cli:<session>`, `agent:<label>:<session>`, `file`, `plugin:<name>`), revisions and touched ids. Pass `since` with your last transaction id " +
      "to see only what happened after it, e.g. what the human changed in the app. Fails with HistoryNotFound when " +
      "`since` is not in this timeline's journal.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      since: TxIdSchema.optional().describe("Only operations journaled after this transaction's last operation."),
    }),
    result: HistoryResultSchema,
  },
  "history.diff": {
    description:
      "What a transaction (`tx_…`) or a single operation (`op_…`) did to a timeline's clips: each clip it added, removed, " +
      "moved (other track or start, same length) or otherwise changed (trim, speed, gain, props), with its track, start " +
      "and end right before and right after the target. Later operations do not change the answer. Use it to see what " +
      "a transaction from `history` changed before you `revert` it. Fails with HistoryNotFound when the id is not in " +
      "the timeline's journal, HistoryUnavailable when the file changed outside the journal after the target.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to diff."),
    }),
    result: HistoryDiffResultSchema,
  },
  revert: {
    mutating: true,
    description:
      "Undo a transaction (`tx_…`) or a single operation (`op_…`) on one timeline by applying the stored inverses, " +
      "newest first, as a new `revert` operation (history stays append-only; reverting a revert redoes). Refused with " +
      "RevertConflict listing the later operations that changed the same tracks or clips: revert those first, newest " +
      "first. Also refused, with empty `conflicts`, when the file changed outside the journal after the target (e.g. " +
      "edited while the daemon was not running): the journal cannot undo what it did not record, so edit forward. Fails with " +
      "HistoryNotFound when the id is not in the timeline's journal.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to undo."),
    }),
    result: OperationResultSchema,
  },
  "ui.state": {
    description:
      "What the user sees in the Frameshell app for this project: the playhead and whether it plays, the selection " +
      "(clip ids, transcript words, a time range, and the History entry whose changes the timeline marks), the " +
      "editor tabs and the timeline seconds visible in the timeline panel. Read it to resolve \"this clip\", \"here\" " +
      "or \"the selected words\" before acting. The app reports every change within 200 ms. `connected: false` (and " +
      "no other field) when no app window shows the project; the other `ui.*` tools then fail with UiNotConnected.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      connected: z.boolean().describe("True when an app window shows the project; every other field is absent otherwise."),
      ...UiStateSchema.partial().shape,
    }),
  },
  "ui.seek": {
    description:
      "Move the app's playhead to timeline second `at` so the preview shows that frame (snapped to the frame, clamped " +
      "to the timeline; playback continues from there if it was playing). Example: `{ at: 12.5 }`. Returns `ui.state` " +
      "after the move. Fails with UiNotConnected when no app window shows the project.",
    params: z.strictObject({
      cwd: CwdParam,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`."),
    }),
    result: UiStateSchema,
  },
  "ui.play": {
    description:
      "Start playback in the app's preview from the playhead (from the start when it is at the end). Returns " +
      "`ui.state`. Fails with UiNotConnected when no app window shows the project.",
    params: z.strictObject({ cwd: CwdParam }),
    result: UiStateSchema,
  },
  "ui.pause": {
    description:
      "Pause playback in the app's preview; the playhead stays where it stopped. Returns `ui.state`. Fails with " +
      "UiNotConnected when no app window shows the project.",
    params: z.strictObject({ cwd: CwdParam }),
    result: UiStateSchema,
  },
  "ui.select": {
    description:
      "Replace the user's selection in the app, to point at what you mean: clips (ids of the timeline `ui.state` " +
      "names, from `timeline.show`), transcript words, and/or a time range. Omitted parts are cleared; nothing given " +
      "clears the selection. With `reveal` (default true) the timeline scrolls to the first clip and, unless playing, " +
      "the playhead moves to its start. Examples: `{ clips: [\"c_1a2b3c\"] }`, `{ range: { from: 12.4, to: 13.1 } }`. " +
      "Returns `ui.state`. Fails with UiCommandFailed naming clip ids the timeline does not have, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      clips: z.array(z.string().min(1)).default([]).describe("Clip ids to select, e.g. `[\"c_1a2b3c\"]`. Default none."),
      words: z
        .array(WordRefSchema)
        .default([])
        .describe("Transcript words to select, e.g. `[{ transcript: \"transcripts/raw-01.words.json\", word: \"w_000123\" }]`. Default none."),
      range: TimeRangeSchema.nullable()
        .default(null)
        .describe("Timeline seconds to select, `{ from, to }` with `to` greater than `from`. Default none."),
      reveal: z.boolean().default(true).describe("Scroll the timeline to the first clip and move the playhead there. Default true."),
    }),
    result: UiStateSchema,
  },
  "ui.openFile": {
    description:
      "Open a project file in an app editor tab and make it the active tab, e.g. the script `scripts/launch.md` or " +
      "`timelines/main.json`. Returns `ui.state`. Fails with OutsideProject for a path outside the project, " +
      "UiCommandFailed when the app cannot read the file, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z
        .string()
        .min(1)
        .describe("File relative to the project root, or absolute inside the project, e.g. `scripts/launch.md`."),
    }),
    result: UiStateSchema,
  },
  "ui.showTxDiff": {
    description:
      "Show the user what a transaction (`tx_…`) or operation (`op_…`) from `history` changed: the app opens its " +
      "History panel on that entry, selects the clips it left and marks every added, removed, moved and changed clip " +
      "on the timeline. Use it to walk the user through your changes. The app shows the `main` timeline only. " +
      "Returns `ui.state` (`selection.history` is the target). Fails with UiCommandFailed when the id is not in the " +
      "timeline's journal, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to show."),
    }),
    result: UiStateSchema,
  },
  "ui.publish": {
    description:
      "App window reports what it shows for the project enclosing `cwd`: registers the window (`view`) as that " +
      "project's UI, so `ui.state` answers from it and navigation commands reach it as `ui.command`. Send on every change.",
    internal: true,
    params: z.strictObject({ cwd: CwdParam, view: UiViewIdSchema, state: UiViewSchema }),
    result: z.object({ dir: z.string().describe("Project root the window is registered for.") }),
  },
  "ui.reply": {
    description:
      "App window answers `ui.command` `id`: `error` null when done, else why not; `state` is its state after the command.",
    internal: true,
    params: z.strictObject({
      view: UiViewIdSchema,
      id: z.string().min(1).describe("`id` of the `ui.command` answered."),
      error: z.string().nullable(),
      state: UiViewSchema,
    }),
    result: z.object({}),
  },
  "ui.detach": {
    description: "App window stops showing its project (closed, or another project opened). Unknown windows are ignored.",
    internal: true,
    params: z.strictObject({ view: UiViewIdSchema }),
    result: z.object({}),
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

/**
 * Notifications the daemon sends (JSON-RPC requests without `id`). Same
 * contract as {@link methods}: Zod params, model-facing description.
 */
export const notifications = {
  progress: {
    description:
      "Progress of a long request on this connection (downloads, builds, transcription). `requestId` is the `id` of " +
      "the request it belongs to; the final reply still arrives as that request's response.",
    params: z.object({
      requestId: z.union([z.int(), z.string()]).describe("`id` of the request in progress."),
      message: z.string().describe("Human line, e.g. `Downloading model ggml-large-v3-turbo-q5_0 (574 MB, one time)`."),
      fraction: z.number().min(0).max(1).optional().describe("0..1 of the current step when known."),
    }),
  },
  "asset.changed": {
    description:
      "An asset of the project changed: its ingest started (`processing`), finished (`ready`, derived media paths " +
      "filled in) or failed, or its file left `assets/` (`asset` null). Sent to connections subscribed with " +
      "`events.subscribe`, in order per asset. `asset` is exactly what `asset.list` reports for it at that moment, so " +
      "no re-read is needed. Ingest progress within a state arrives as `job.progress`.",
    // TODO(#75): the MCP server forwards this (and transcript file changes) as `notifications/resources/list_changed`.
    params: z.object({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
      path: z.string().describe("Project-relative asset path, e.g. `assets/raw-01.mp4`."),
      asset: AssetSchema.nullable().describe("The asset as `asset.list` reports it now; null when the file is gone."),
    }),
  },
  "job.progress": {
    description:
      "A background job of the project changed: queued, running, a new step or more progress, then `done`, `failed` " +
      "or `canceled`. Sent to connections subscribed with `events.subscribe`, in order per job; progress-only updates " +
      "are sent at most every 200 ms per job, state and step changes at once. `job` is the same snapshot `job.list` " +
      "returns. Replaces polling `job.list`: read it once after subscribing, then follow the events.",
    params: z.object({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
      job: JobSchema,
    }),
  },
  "timeline.changed": {
    description:
      "A timeline file was changed by an applied operation, from any client or a direct edit of the file (author `file`). Sent to connections subscribed with " +
      "`events.subscribe` on the project, after the file is written, in revision order per timeline. Re-read with " +
      "`timeline.show` when `revision` is newer than the one you hold; `changes` says what to re-read.",
    params: z.object({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
      timeline: z.string().describe("Timeline id; the file is `timelines/<id>.json`."),
      revision: z.int().describe("Revision after the change."),
      author: z
        .string()
        .describe("`ui`, `cli:<session>`, `cli`, `agent:<label>:<session>`, `file` (direct edit of the file) or `plugin:<name>`."),
      changes: OperationResultSchema.shape.changes,
    }),
  },
  "timeline.rejected": {
    description:
      "A direct edit of a timeline file was refused (SPEC §6.4): its `revision` was stale, or its content invalid. The " +
      "daemon's version is back on disk, so no `timeline.changed` follows; the edit is kept at `preserved` for recovery. " +
      "Also listed by `status` as `rejections`.",
    params: TimelineRejectionSchema.extend({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
    }),
  },
  "ui.command": {
    description:
      "Navigation command for one app window (`view`, as it registered with `ui.publish`). Not subscribable: sent to " +
      "the window that last reported for the project. The window answers with `ui.reply` carrying `id`.",
    params: z.object({
      project: z.string().describe("Absolute project root the window registered for."),
      view: UiViewIdSchema,
      id: z.string().describe("Command id to answer with `ui.reply`."),
      command: UiCommandSchema,
    }),
  },
} as const satisfies Record<string, { description: string; params: z.ZodType }>;

/** Name of a subscribable event. */
export type EventName = z.output<typeof EventNameSchema>;

/** Every subscribable event name, for runtime checks. */
export const EVENT_NAMES: readonly EventName[] = EventNameSchema.options;

/** Params of notification `E`, as the daemon sends them. */
export type EventParams<E extends keyof typeof notifications> = z.output<(typeof notifications)[E]["params"]>;

/** Any notification the daemon sends. */
export type NotificationName = keyof typeof notifications;

/** Params of the `progress` notification. */
export type ProgressParams = z.output<(typeof notifications)["progress"]["params"]>;

/** One progress report as a request's caller sees it. */
export type Progress = Omit<ProgressParams, "requestId">;

/** `transcribe` params. */
export type TranscribeParams = MethodParams<"transcribe">;
/** Result of `transcribe`. */
export type TranscribeResult = MethodResult<"transcribe">;
/** `transcribe.verify` params. */
export type TranscribeVerifyParams = MethodParams<"transcribe.verify">;
/** Result of `transcribe.verify`. */
export type TranscribeVerifyResult = MethodResult<"transcribe.verify">;
/** One word of `transcribe.verify` `lost`. */
export type LostWord = z.output<typeof LostWordSchema>;
/** One word of `transcribe.verify` `uncertain`. */
export type UncertainWord = z.output<typeof UncertainWordSchema>;

/** Result of `script.outline`. */
export type ScriptOutlineResult = MethodResult<"script.outline">;

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
/** `render` params. */
export type RenderParams = MethodParams<"render">;
/** Result of `render`. */
export type RenderResult = MethodResult<"render">;
/** `frame` params. */
export type FrameParams = MethodParams<"frame">;
/** Result of `frame`. */
export type FrameResult = MethodResult<"frame">;
/** One export preset as listed by `export.presets`. */
export type ExportPresetInfo = z.output<typeof ExportPresetResultSchema>;
/** `file.write` params. */
export type FileWriteParams = MethodParams<"file.write">;
/** Result of `file.write`. */
export type FileWriteResult = MethodResult<"file.write">;
/** Background job as reported by `status` and `job.list`. */
export type JobInfo = z.output<typeof JobSchema>;
/** Step of a running {@link JobInfo}. */
export type JobStep = NonNullable<JobInfo["step"]>;
/** Result of `clip.renders`. */
export type ClipRendersResult = MethodResult<"clip.renders">;
/** Render cache state of one generated clip, as `clip.renders` reports it. */
export type ClipRenderInfo = z.output<typeof ClipRenderSchema>;
/** ffprobe summary of an asset. */
export type MediaProbe = z.output<typeof ProbeSchema>;
/** One asset as reported by `asset.list`. */
export type AssetInfo = z.output<typeof AssetSchema>;
/** `asset.import` params. */
export type AssetImportParams = MethodParams<"asset.import">;
/** Result of `asset.import`. */
export type AssetImportResult = MethodResult<"asset.import">;
/** `gc` params. */
export type GcParams = MethodParams<"gc">;
/** Result of `gc`. */
export type GcResult = MethodResult<"gc">;
/** One deleted (or deletable) entry of a {@link GcResult}. */
export type GcEntry = z.output<typeof GcEntrySchema>;
/** One area a {@link GcResult} left alone. */
export type GcSkip = z.output<typeof GcSkipSchema>;
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

/**
 * Validate a raw request for `method`: split off a {@link MethodSpec.mutating}
 * method's `idempotencyKey` (null when absent), then {@link parseParams} the
 * rest. Other methods get no special field: their strict params refuse it.
 * Throws {@link RpcError} `InvalidParams` like {@link parseParams}.
 */
export function parseRequest<M extends MethodName>(
  method: M,
  params: unknown,
): { params: ValidatedParams<M>; idempotencyKey: string | null } {
  const spec: MethodSpec = methods[method];
  if (!spec.mutating || typeof params !== "object" || params === null || !Object.hasOwn(params, "idempotencyKey")) {
    return { params: parseParams(method, params), idempotencyKey: null };
  }
  const { idempotencyKey: raw, ...rest } = params as Record<string, unknown>;
  const key = IdempotencyKeySchema.safeParse(raw);
  if (!key.success) {
    const issues = key.error.issues.map(({ message }) => ({ path: ["idempotencyKey"], message }));
    const lines = issues.map(({ message }) => `  params.idempotencyKey: ${message}`);
    throw new RpcError(ErrorCode.InvalidParams, `Invalid params for \`${method}\`:\n${lines.join("\n")}`, { issues });
  }
  return { params: parseParams(method, rest), idempotencyKey: key.data };
}

/** JSON Schema (draft 2020-12) of one method, for tool generation. */
export interface MethodJsonSchema {
  description: string;
  /** See {@link MethodSpec.internal}. */
  internal: boolean;
  /** See {@link MethodSpec.mutating}. */
  mutating: boolean;
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
      mutating: spec.mutating ?? false,
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
  /** data: `{ path }` of the missing or non-file source */
  AssetNotFound: -32019,
  /** data: `{ provider, available: string[] }` */
  TranscriptionProviderNotFound: -32020,
  /** data: `{ provider, asset, details }` */
  TranscriptionFailed: -32021,
  /** data: `{ asset, transcripts: { path, asset }[] }`: every transcript name for the asset belongs to another asset */
  TranscriptNameTaken: -32022,
  /** data: `{ timeline, path, available: string[] }` */
  TimelineNotFound: -32023,
  /** data: `{ track, available: string[] }` */
  TrackNotFound: -32024,
  /** data: `{ clip }` */
  ClipNotFound: -32025,
  /**
   * data: `{ op, reason, field?, valid?: { min, max }, hint? }`: the operation breaks a timeline rule
   * (overlap, source bounds, track kind…); `valid` is the allowed range in seconds when one exists.
   */
  InvalidOperation: -32026,
  /**
   * data: `{ timeline, track, clip, source, broken, reason, details }`: clip `clip` nests `source`, whose duration
   * cannot be derived because `broken` (`source` itself or a file it nests) is `missing`, `invalid` or in a `cycle`.
   */
  NestedTimelineUnavailable: -32027,
  /** data: `{ preset, available: string[] }` */
  PresetNotFound: -32028,
  /** data: `{ timeline, track?, clip? }`: the timeline is empty or holds what export cannot render yet. */
  ExportUnsupported: -32029,
  /** data: `{ author, open: { tx, label } | null, hint }`: no session, or a transaction already open / none open. */
  TransactionState: -32030,
  /** data: `{ target, timeline }`: the tx or op id is not in that timeline's journal. */
  HistoryNotFound: -32031,
  /**
   * data: `{ target, timeline, conflicts: { id, op, author, tx, ids }[], hint }`: later operations changed tracks or clips
   * the revert would restore (`ids`); or `conflicts` is empty and the file changed outside the journal. From `tx.abort`
   * also `timelines: { root, timeline, conflicts, hint }[]`, one per refused timeline; `timeline` is the first of them.
   */
  RevertConflict: -32032,
  /** data: `{ path, available: string[] }`: project-relative script asked for, and the `scripts/**\/*.md` there are. */
  ScriptNotFound: -32033,
  /**
   * data: `{ path, timeline, revision, current }`: a timeline write carried `revision` but the timeline is at
   * `current`. Re-read the file, reapply the edit, write again.
   */
  StaleRevision: -32034,
  /**
   * data: `{ target, timeline, hint }`: the timeline file changed outside the journal after the target, so its
   * states cannot be replayed (`history.diff`).
   */
  HistoryUnavailable: -32035,
  /** data: `{ project, hint }`: no app window shows the project (`ui.*` navigation). */
  UiNotConnected: -32036,
  /** data: `{ command, reason }`: the app refused the navigation command or did not answer in time. */
  UiCommandFailed: -32037,
  /** data: `{ clip, type, timeline, details }`: a generated clip could not be rendered (adapter error, or no plugin renders its type). */
  ClipRenderFailed: -32038,
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
