import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  OperationResultSchema,
  TimelineIdSchema,
  TimelineProblemSchema,
  TimelineViewSchema,
  TrackSummarySchema,
  operationArgs,
} from "./timeline.js";

/**
 * Wire protocol version. Client and daemon must match exactly; bump on any
 * breaking change to a method, param, result or error code.
 */
export const PROTOCOL_VERSION = 7;

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
    .enum(["ingest", "render"])
    .describe(
      "`ingest`: probe an asset and build its proxy, PCM sidecar, waveform and thumbnails. " +
        "`render`: export a timeline to a video file (`render` method).",
    ),
  project: z.string().describe("Absolute root of the project the job belongs to."),
  asset: z
    .string()
    .describe(
      "Project-relative, `/`-separated input: the asset for `ingest` (e.g. `assets/raw-01.mp4`), the timeline file for " +
        "`render` (e.g. `timelines/main.json`).",
    ),
  output: z.string().nullable().describe("`render`: absolute path of the file being written. Null for `ingest`."),
  state: z
    .enum(["queued", "running", "done", "failed", "canceled"])
    .describe("`canceled`: the daemon stopped before the job finished; it is queued again when the project reopens."),
  step: z
    .enum(["hash", "probe", "proxy", "sidecar", "waveform", "thumbnails", "video", "mux"])
    .nullable()
    .describe(
      "Step running now; null when not running. `ingest`: hash, probe, proxy, sidecar, waveform, thumbnails, in this " +
        "order. `render`: video (segments encoded in parallel, loudness measured alongside), then mux (joins segments, " +
        "normalizes and encodes audio).",
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
      "Project-relative CFR proxy: H.264 at project fps, GOP 15, no B-frames (frame index = sample index), faststart, " +
        "short side at most 540 px. Null for audio-only, still images, or before ingest.",
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
      jobs: z
        .array(JobSchema)
        .describe("Background jobs of `project` in this daemon run, oldest first; empty when there is no project."),
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
    description:
      "Export a timeline to a video file (SPEC §3.5) as a background job, and return at once with the job. Video is " +
      "encoded in segments in parallel and joined; audio is mixed in one continuous pass with a 2 ms fade at every cut, " +
      "`atempo` for clip speed, then two-pass loudness normalization to the target (preset `loudness`, else " +
      "`export.loudness` in `frameshell.json`, else -17 LUFS integrated). Follow the job with `job.list` until it is " +
      "`done` (the file exists at `output`) or `failed` (`error` says why). Renders from the original assets, not " +
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
    description:
      "Bring media files into the enclosing project's `assets/` and queue their ingest (probe, CFR proxy, PCM sidecar, " +
      "waveform, thumbnails). Returns at once; follow progress with `job.list` or `status`. Files already under " +
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
  "job.list": {
    description:
      "Background jobs of the enclosing project (ingest), with state and progress. Jobs keep running after the caller " +
      "disconnects; poll this until every job you care about is `done` or `failed`.",
    params: z.strictObject({
      cwd: CwdParam,
      active: z.boolean().default(false).describe("Only `queued` and `running` jobs. Default false: also finished ones."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      jobs: z.array(JobSchema).describe("Oldest first."),
    }),
  },
  transcribe: {
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
      seconds: z.number().describe("Wall time of the whole call, including first-run downloads."),
    }),
  },
  "file.write": {
    description:
      "Write a UTF-8 text file inside a Frameshell project (scripts, compositions, config), replacing it atomically. " +
      "Missing parent directories are created. `frameshell.json`, `timelines/*.json` and `transcripts/**/*.words.json` must pass schema validation " +
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
    description:
      "Add a track and return its new id (`t_…`). Example: `{ kind: \"video\", name: \"Camera\" }`; subtitle tracks need " +
      "`follows`: `{ kind: \"subtitles\", follows: \"t_4d5e6f\" }`. Placed on top unless `index` is given.",
    params: operationArgs["track.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.remove": {
    description:
      "Remove a track. A track with clips needs `force: true`; a track followed by a subtitle track is refused until that " +
      "subtitle track is removed. Fails with TrackNotFound or InvalidOperation.",
    params: operationArgs["track.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.add": {
    description:
      "Place a clip on a video or audio track and return its new id (`c_…`) in `changes.added`. Media example: " +
      "`{ track: \"t_4d5e6f\", asset: \"assets/raw-01.mp4\", start: 0, in: 3.2, out: 15.733 }` (in/out are source seconds, " +
      "default the whole asset; start defaults to right after the track's last clip). Adapter example: " +
      "`{ track, type: \"hyperframes\", source: \"compositions/hyperframes/intro/index.html\", duration: 8, props: {…} }`. " +
      "Times snap to the project frame grid. Fails with InvalidOperation (overlap, out beyond the source duration, wrong " +
      "track kind, unknown clip type; data says the valid range), AssetNotFound, TrackNotFound.",
    params: operationArgs["clip.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.move": {
    description:
      "Move a clip to a new timeline `start` and/or another track of the same kind, keeping its content and length. " +
      "Example: `{ clip: \"c_1a2b3c\", start: 12.5 }`. Refused when it would overlap another clip.",
    params: operationArgs["clip.move"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.trim": {
    description:
      "Trim or extend a clip's head and/or tail. By source time: `{ clip, in: 4.0 }` drops source before 4.0 s, the kept " +
      "frames stay where they were on the timeline (start moves right). By timeline time: `{ clip, end: 20.0 }`. Does not " +
      "ripple: use `cut` to close gaps. Fails with InvalidOperation giving the valid range.",
    params: operationArgs["clip.trim"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.split": {
    description:
      "Split a clip in two at timeline time `at`. The left part keeps the id; the right part's new id is in " +
      "`changes.added`. Example: `{ clip: \"c_1a2b3c\", at: 7.5 }`.",
    params: operationArgs["clip.split"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.remove": {
    description: "Remove a clip, leaving a gap. To remove a time range and close the gap on every track, use `cut`.",
    params: operationArgs["clip.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.set": {
    description:
      "Change clip properties: `speed` (media; end moves), `gain` (dB), `muted`, `transform` (merged field by field), " +
      "`props` (adapter clips; replaced), `scriptRef` (null clears). Example: `{ clip: \"c_1a2b3c\", gain: -6 }`.",
    params: operationArgs["clip.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  cut: {
    description:
      "Remove the timeline range [from, to) and close the gap (ripple): clips inside are removed, clips crossing an edge " +
      "are trimmed or split, later clips move left by `to - from`. Applies to every video and audio track unless " +
      "`tracks` is given (cutting only some tracks shifts them against the rest). Example: `{ from: 12.4, to: 13.1 }` " +
      "removes a 0.7 s silence.",
    params: operationArgs.cut.extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
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
} as const satisfies Record<string, { description: string; params: z.ZodType }>;

/** Params of the `progress` notification. */
export type ProgressParams = z.output<(typeof notifications)["progress"]["params"]>;

/** One progress report as a request's caller sees it. */
export type Progress = Omit<ProgressParams, "requestId">;

/** `transcribe` params. */
export type TranscribeParams = MethodParams<"transcribe">;
/** Result of `transcribe`. */
export type TranscribeResult = MethodResult<"transcribe">;

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
/** ffprobe summary of an asset. */
export type MediaProbe = z.output<typeof ProbeSchema>;
/** One asset as reported by `asset.list`. */
export type AssetInfo = z.output<typeof AssetSchema>;
/** `asset.import` params. */
export type AssetImportParams = MethodParams<"asset.import">;
/** Result of `asset.import`. */
export type AssetImportResult = MethodResult<"asset.import">;
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
