/** Spec type and schemas shared by the per-area method modules merged into `methods` (`../methods.ts`). */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TimelineViewNameSchema } from "../proposals.js";
import {
  AudioEffectSchema,
  SFX_PITCH_RANGE,
  SFX_SEED_MAX,
  SFX_VARIANTS,
  SOUND_TYPING_RATE,
  SfxKindSchema,
  SoundRoleSchema,
  SoundTierSchema,
} from "@frameshell/schema";
import { TimeRefParam, TxIdSchema } from "../timeline.js";
import type { FormatChange, StyleChange } from "../methods.js";

/**
 * One daemon method as declared in the `methods` registry (`../methods.ts`).
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
  /**
   * Connection plumbing, or a method only the app uses (`ui.publish`, `clip.live`): never exposed as an MCP tool
   * or CLI command.
   */
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
export const AbsolutePath = z.string().refine(isAbsolute, { message: "must be an absolute path" });

/** Who answered the handshake: protocol and daemon versions, process. */
export const DaemonIdentitySchema = z.object({
  protocolVersion: z.int().describe("Wire protocol version the daemon speaks."),
  daemonVersion: z.string().describe("frameshelld package version."),
  pid: z.int().describe("Daemon process id."),
});

/** Summary of an open project in connection and project-setup results. */
export const ProjectSummarySchema = z.object({
  dir: z.string().describe("Absolute directory holding `frameshell.json`."),
  name: z.string().describe("Project display name."),
  schemaVersion: z.int().describe("On-disk schema version of the project files."),
});

/** One managed binary in the `doctor` report. */
export const BinaryReportSchema = z.object({
  name: z.string().describe("Executable name without extension, e.g. `ffmpeg`."),
  package: z.string().describe("Managed package that ships it, e.g. `ffmpeg` (also ships `ffprobe`)."),
  source: z
    .enum(["managed", "project", "global", "system"])
    .describe(
      "`managed`: pinned download under the app data dir. `project` / `global`: path from `binaries` in " +
        "`frameshell.json` / the global `config.json`. `system`: the person's own install of a tool Frameshell never downloads " +
        "(Blender), found where its installer puts it because no `binaries` override names one; `found` says how.",
    ),
  found: z
    .enum(["path", "standard"])
    .optional()
    .describe("Only with `source: \"system\"`: `path` = found on PATH, `standard` = at the product's usual install location (e.g. `/Applications/Blender.app`)."),
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
      bytes: z.number().describe("Download size of the build's archives, bytes."),
    })
    .nullable()
    .describe(
      "Managed build chosen for this machine; null when none is pinned. GPU builds are chosen when the GPU and " +
        "toolchain are detected, else the CPU build.",
    ),
});

/** One managed download on disk: what `doctor` lists and `binaries.remove` frees. */
export const ManagedDownloadSchema = z.object({
  name: z.string().describe("Name `binaries.remove` takes: a package (`ffmpeg`, `whisper-cpp`) or a pinned model id (`ggml-large-v3-turbo-q5_0`)."),
  kind: z.enum(["package", "model"]).describe("`package`: native tools or modules; `model`: one pinned model file."),
  tools: z.array(z.string()).describe("Tools a package ships (`ffmpeg`, `ffprobe`); empty for a model."),
  versions: z.array(z.string()).describe("Installed version directory names (a model: revisions), sorted by name."),
  bytes: z.number().describe("Bytes on disk under the data dir, in every installed version."),
});

/** One ffmpeg codec in the `doctor` report. */
export const CodecReportSchema = z.object({
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

/** H.264 encoder a render can use. */
export const EncoderNameSchema = z
  .enum(["h264_videotoolbox", "h264_nvenc", "libx264"])
  .describe("H.264 encoder, in the order tried: VideoToolbox (macOS), NVENC (NVIDIA), x264 (software, always the last resort).");

/** Encode quality tier of renders and proxies. */
export const QualityTierSchema = z
  .enum(["master", "preview", "draft", "final"])
  .describe(
    "Encode quality tier. `master`: intermediates kept for later passes (x264 CRF 16 medium). `preview`: throwaway " +
      "looks (CRF 26 veryfast). `draft`: review rounds (30 fps at most, CRF 22 veryfast). `final`: the delivery " +
      "(CRF 16 slow, bt709 tags, faststart). Hardware encoders use their own equivalent settings.",
  );

/** Which H.264 encoder this machine uses, from test encodes. */
export const EncoderReportSchema = z.object({
  picked: EncoderNameSchema.nullable().describe("The encoder renders use: the first candidate that encoded; null when none did."),
  cached: z.boolean().describe("The answer came from the per-machine cache (`encoders.json` in the data dir) instead of fresh test encodes."),
  probedAt: z.string().describe("ISO timestamp of the test encodes."),
  candidates: z
    .array(
      z.object({
        name: EncoderNameSchema,
        label: z.string(),
        compiled: z.boolean().describe("Listed by `ffmpeg -encoders`."),
        works: z.boolean().describe("A 0.2 s test encode of lavfi colour succeeded on this machine."),
        ms: z.number().nullable().describe("Wall time of the test encode; null when not run (not compiled in)."),
      }),
    )
    .describe("Every candidate in preference order."),
});

/** Speed class and resources of this machine in the `doctor` report. */
export const MachineProfileSchema = z.object({
  class: z.enum(["fast", "medium", "slow"]).describe("Machine speed class from CPU cores, memory and whether a hardware encoder works."),
  cpuCores: z.int(),
  memoryGb: z.number(),
  proxyShortSide: z.int().describe("Recommended short side in px for preview proxies on this machine."),
  draftShortSide: z.int().describe("Recommended short side in px for draft renders (review rounds); pick a preset of about that size."),
  resolution: z.object({ width: z.int(), height: z.int() }).describe("Project resolution the disk estimate is for."),
  fps: z.number().describe("Project frame rate the disk estimate is for."),
  masterMbPerMinute: z.int().describe("Disk a `master` intermediate takes per minute of video at the project resolution and fps (upper bound, megabytes)."),
});

/**
 * Whether a project's declared plugins may load (SPEC §6.6). `not-required`:
 * no plugins declared. `unknown`: never decided for this exact plugin list.
 */
export const TrustStateSchema = z
  .enum(["not-required", "unknown", "trusted", "denied"])
  .describe(
    "Plugin trust: `not-required` (no plugins declared), `unknown` (never decided for this plugin list), " +
      "`trusted` (plugins load), `denied` (plugins stay off).",
  );

/** Declared plugin pins of a project. */
export const PinsSchema = z
  .record(z.string(), z.string())
  .describe("Declared plugins from `frameshell.json`: package name to pinned npm spec (exact version or git URL#commit).");

/** One deleted (or deletable) entry of a `gc` result. */
export const GcEntrySchema = z.object({
  path: z.string().describe("Project-relative, `/`-separated; a directory ends with `/`."),
  kind: z
    .enum(["proxy", "sidecar", "manifest", "waveform", "thumbnails", "energy", "loudness", "beats", "audio", "audio-fx", "voice", "clip", "context", "proposal", "people", "shoot", "matte", "temp"])
    .describe(
      "`proxy`, `sidecar`, `manifest`, `waveform`, `thumbnails`: ingest outputs of content no asset has now (or of an " +
        "older recipe or fps). `energy`: cut-snapping envelope. `loudness`: EBU R128 reading of an asset in `.frameshell/loudness/` (content no asset has now). `beats`: onset envelope of the beat detector in `.frameshell/beats/` (the grids in `beats/` are project files and never deleted). `audio`: WAV extracted for transcription. `audio-fx`: baked " +
        "audio effects in `.frameshell/audio-fx/` no clip of any timeline plays now (ADR 0031). `voice`: " +
        "voice prints in `.frameshell/people/voices/` of content no asset has now. `clip`: " +
        "generated-clip render no timeline uses, or a file a clip plugin keeps for its clips that none of them names now (the " +
        "Blender plugin's listings, length and version markers in `.frameshell/blender/`). `context`: \"Chat about this\" frame capture or pick details in " +
        "`.frameshell/context/`, older than 7 days. `proposal`: rejected, stale or aborted review-mode proposal in " +
        "`.frameshell/proposals/`, decided more than 7 days ago. `people`: face scan of content no asset has now (or of " +
        "other models) in `.frameshell/people/`. `shoot`: take comparison of a script or transcript that changed since, in " +
        "`.frameshell/shoot/`. `matte`: subject matte in `.frameshell/cache/mattes/` of content no asset has now (or of " +
        "another model, fps or matte version). `temp`: leftover of an interrupted job or transcription.",
    ),
  bytes: z.int().describe("Size on disk; a directory counts its files."),
});

/** One measured beat grid of an asset (`beats.*`). */
export const BeatsSummarySchema = z.object({
  asset: z.string().describe("Project-relative asset path."),
  file: z.string().describe("Project-relative beats file, e.g. `beats/theme.beats.json`."),
  hash: z.string().describe("`sha256:<hex>` of the asset's content the grid was measured from."),
  detector: z.string().describe("`onset-flux@2` (older files keep `onset-flux@1`), or `exact` for a grid a generator wrote."),
  bpm: z.number().describe("Beats per minute, `edits.tempo` applied."),
  meter: z.int().describe("Beats per bar."),
  confidence: z.number().min(0).max(1).describe("0..1; under 0.5 the grid may be wrong."),
  low: z.boolean().describe("True when the grid is low confidence and no human `edit` vouches for it: do not trust or snap to it without a look."),
  residualMs: z.number().nullable().describe("Largest gap between the straight grid and the hits it matched, ms; null for an exact grid."),
  sampleRate: z.int().nullable().describe("Sample rate of the analysed audio; 16000 means the fallback decode (low confidence)."),
  alternatives: z
    .array(z.object({ tempo: z.enum(["double", "half"]), bpm: z.number() }))
    .describe("Other tempi to try when `low`, best supported first; set one as `edits.tempo`. Empty otherwise."),
  beatCount: z.int().describe("Number of beats in the grid."),
  onsetCount: z.int().describe("Number of strong hits measured."),
});

/** One area a `gc` run left alone. */
export const GcSkipSchema = z.object({
  area: z
    .enum(["media", "clips", "audio", "audio-fx", "temp"])
    .describe("What was left alone: derived media, the clip render cache, transcription WAVs, baked audio effects, or job temp files."),
  reason: z.string(),
});

/** `cwd` param shared by project methods. */
export const CwdParam = AbsolutePath.describe(
  "Absolute directory inside the project, e.g. `/home/ana/videos/launch`. The project is found searching upwards.",
);

/** `view` of the reads review mode (ADR 0019) affects. */
export const ViewParam = TimelineViewNameSchema.optional();

/** Default and longest `proposal.wait` in seconds. */
export const PROPOSAL_WAIT_DEFAULT_S = 300;
/** See {@link PROPOSAL_WAIT_DEFAULT_S}. */
export const PROPOSAL_WAIT_MAX_S = 3600;

/** One plugin as the `plugin.*` methods report it. */
export const PluginInfoSchema = z.object({
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
      speechProviders: z.array(z.string()).describe("Speech providers for `voiceover.generate` (ADR 0034)."),
      commands: z.array(z.string()).describe("`<group> <command>`, run as `frameshell <group> <command>`."),
      exportPresets: z.array(z.string()),
      skills: z.array(z.string()).describe("Absolute paths of the plugin's agent skill files."),
    })
    .nullable()
    .describe("Declared contributions; null unless the manifest was read."),
});

/** One background job as `job.list` reports it. */
export const JobSchema = z.object({
  id: z.string().describe("Job id, e.g. `j_12`. Unique within one daemon run."),
  kind: z
    .enum(["ingest", "render", "clip", "faces", "people", "shoot", "audio-fx", "matte", "beats", "analyze", "brand"])
    .describe(
      "`ingest`: probe an asset and build its proxy, PCM sidecar, waveform and thumbnails. " +
        "`audio-fx`: bake one asset through a clip's audio effects into `.frameshell/audio-fx/` (ADR 0031). " +
        "`render`: export a timeline to a video file (`render` method). " +
        "`clip`: render one generated clip (e.g. `hyperframes`) into the clip render cache (`clip.renders`). " +
        "`faces`: find faces in a multicam group's angles and write reframe keys (`multicam.faces`). " +
        "`people`: find, follow and embed the faces of video assets (`people.scan`). " +
        "`shoot`: transcribe one take recorded in the app and compare it with its shoot script (ADR 0024). " +
        "`matte`: compute the subject matte of one video asset (`matte.prepare`). " +
        "`beats`: measure the beat grid of one music asset (`beats.measure`). " +
        "`analyze`: measure a reference video's shots, colours, look, rhythm, events, loudness and tempo (`analyze`). " +
        "`brand`: capture a public web page's logos, colours and fonts into the project (`brand.capture`).",
    ),
  project: z.string().describe("Absolute root of the project the job belongs to."),
  asset: z
    .string()
    .describe(
      "Project-relative, `/`-separated input: the asset for `ingest` (e.g. `assets/raw-01.mp4`), the timeline file for " +
        "`render` and `faces` (e.g. `timelines/main.json`), the composition for `clip` (the clip's `source`, else `<type>:<clip id>`), " +
        "the scanned videos for `people` (comma-separated), the asset for `audio-fx`, the video for `matte`, the music for `beats`, the video for `analyze` (project-relative when inside the project, else absolute), the URL for `brand`.",
    ),
  output: z
    .string()
    .nullable()
    .describe(
      "`render`: absolute path of the file being written. `clip`: absolute cache entry without extension, " +
        "`.frameshell/cache/clips/<key>` (the render lands at `<key>.webm`, or `<key>.mp4` when opaque). `audio-fx`: absolute bake " +
        "file `.frameshell/audio-fx/<key>.pcm`. Null for `ingest`.",
    ),
  priority: z
    .enum(["interactive", "background"])
    .describe(
      "Order of a `queued` job in its queue. `background` waits behind every `interactive` job; the clip renders the daemon queues " +
        "by itself for timelines nobody is looking at are `background`, and a `clip.renders` or export request for one makes it " +
        "`interactive`. Every other job is `interactive` (first come, first served). A running job is never interrupted.",
    ),
  position: z
    .int()
    .min(1)
    .nullable()
    .describe(
      "Place in the order a `queued` job starts in, 1 = next (clip renders run one at a time; other jobs two at a time, " +
        "so 1 and 2 start together when both slots are free). Null unless `queued`. As of this snapshot: " +
        "it moves when other jobs are queued, promoted, started or canceled.",
    ),
  state: z
    .enum(["queued", "running", "done", "failed", "canceled"])
    .describe("`canceled`: stopped by `job.cancel`, or the daemon stopped before the job finished; an `ingest` is queued again when the project reopens."),
  step: z
    .enum(["hash", "probe", "proxy", "sidecar", "waveform", "thumbnails", "clips", "audio-fx", "video", "mux", "render", "faces", "people", "transcribe", "matte", "beats", "analyze", "capture"])
    .nullable()
    .describe(
      "Step running now; null when not running. `ingest`: hash, probe, proxy, sidecar, waveform, thumbnails, in this " +
        "order. `render`: clips (waits for generated clips to finish rendering into the cache), audio-fx (bakes clip audio " +
        "effects not baked yet), matte (makes the subject mattes of the plates of tracks `behind` one that are not made yet), video (segments " +
        "encoded in parallel, loudness measured alongside), then mux (joins segments, normalizes and encodes audio). " +
        "`clip`: render (the adapter plugin renders the composition). `faces`: faces (one angle after another). `people`: people (one video after another). " +
        "`shoot`: transcribe. `matte`: matte (every frame through the model, then refined and encoded). `beats`: beats (the whole track through the detector). `analyze`: analyze (shots, colours, every frame for look, rhythm and events, loudness, tempo, then the sheets). `brand`: capture (load, scroll, measure, fetch, save).",
    ),
  progress: z.number().min(0).max(1).describe("Overall fraction done, 0 to 1."),
  cached: z
    .boolean()
    .nullable()
    .describe("True when unchanged content reused existing outputs and nothing was re-encoded; null until known."),
  error: z.string().nullable().describe("Why the job failed; null otherwise."),
  warnings: z
    .array(z.string())
    .describe("Problems found while the job ran or in its result, e.g. a loop render whose last frame repeats frame 0 (`render` with `loop`); empty when none."),
  createdAt: z.string().describe("ISO 8601 time the job was queued."),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

/** Baked sound of one asset through one audio effect chain (ADR 0031). */
export const AudioBakeSchema = z.object({
  asset: z.string().describe("Project-relative asset baked."),
  effects: z.array(AudioEffectSchema).describe("The chain, every parameter given (`normalizeAudioEffects`)."),
  clips: z.array(z.string()).describe("Clips playing this bake (flattened ids `<nested clip>/<clip>` inside nested timelines)."),
  state: z
    .enum(["ready", "queued", "baking", "failed"])
    .describe("`ready`: `file` holds the bake. `queued` / `baking`: an `audio-fx` job is on it (`job`). `failed`: see `error`."),
  file: z.string().nullable().describe("Project-relative raw s16le PCM on the sidecar clock, e.g. `.frameshell/audio-fx/<key>.pcm`; null unless ready."),
  sampleRate: z.int().describe("Samples per second of `file`, the sidecar's."),
  channels: z.int().describe("Interleaved channels of `file`, the sidecar's."),
  job: z.string().nullable().describe("Queued or running `audio-fx` job; null otherwise."),
  error: z.string().nullable().describe("Why the bake failed; null otherwise."),
});

/** Subject matte of one plate asset as the preview needs it (ADR 0032). */
export const MatteStateSchema = z.object({
  asset: z.string().describe("Project-relative video asset a subject layer plays."),
  state: z
    .enum(["ready", "queued", "making", "waiting", "failed"])
    .describe(
      "`ready`: `matte` holds it. `queued` / `making`: a `matte` job is on it (`job`, `progress`). `waiting`: the asset's ingest " +
        "has not built its proxy yet; asked again after it, the matte is queued. `failed`: see `error`; retried once the asset changes.",
    ),
  matte: z.string().nullable().describe("Project-relative matte video, `.frameshell/cache/mattes/<key>.mp4` (frame N = proxy frame N); null unless ready."),
  progress: z.number().min(0).max(1).describe("Fraction of the matte job done; 1 when ready, 0 otherwise."),
  job: z.string().nullable().describe("Queued or running `matte` job; null otherwise."),
  error: z.string().nullable().describe("Why the matte could not be made; null otherwise."),
});

/** The final render of a generated clip that has two (ADR 0041 decision 11, ADR 0035): its own cache entry and state. */
export const ClipFinalRenderSchema = z.object({
  state: z
    .enum(["ready", "waiting", "queued", "rendering", "failed"])
    .describe(
      "`ready`: `file` holds it; the preview plays it instead of the draft. `waiting`: it is queued once the draft render is " +
        "ready (a draft that failed must be fixed first); a plugin's own final (Blender's Cycles render) waits until a `render` with " +
        "`quality: \"final\"` or no quality asks for it. `queued` / `rendering`: a `clip` job is on it (`job`, `progress`), " +
        "in the background unless an export or `frame` waits for it. `failed`: see `error`; final and untiered exports retry " +
        "it, except when the plugin refused it (motion blur on HDR content or shader transitions), where they use the draft " +
        "render with a warning.",
    ),
  key: z.string().describe("Cache key: the draft's inputs plus the clip's `motionBlur` with its defaults filled in, or plus the final tier of a plugin with finals."),
  file: z.string().nullable().describe("Project-relative cached render, `.frameshell/cache/clips/<key>.webm` or `.mp4`; null until ready."),
  hasAlpha: z.boolean().nullable().describe("True when `file` carries alpha; null until ready."),
  width: z.int().nullable().describe("Rendered width in pixels; null until ready."),
  height: z.int().nullable().describe("Rendered height in pixels; null until ready."),
  duration: z.number().nullable().describe("Rendered seconds; null until ready or unknown."),
  job: z.string().nullable().describe("Id of the `clip` job rendering it now; null otherwise."),
  progress: z.number().min(0).max(1).describe("0..1 of the running render; 1 when ready, 0 otherwise."),
  error: z.string().nullable().describe("Why the render failed; null otherwise."),
  refused: z
    .boolean()
    .describe("True when `failed` because the plugin refused the motion blur: exports and `frame` then use the draft render, never waiting for this one."),
  onDemand: z
    .boolean()
    .optional()
    .describe(
      "True for a plugin's own final (ADR 0035, Blender's Cycles render): made only when a final or untiered `render` waits for it; " +
        "`frame` and `review` never wait for it (they use it when `ready`, else the draft). Absent or false: the blurred final of ADR 0041.",
    ),
});

/** Render cache state of one generated clip (SPEC §6.5). */
export const ClipRenderSchema = z.object({
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
  final: ClipFinalRenderSchema.optional().describe(
    "Present when the clip keeps two renders (ADR 0041): one with `motionBlur`, on a plugin that applies it. The fields above " +
      "are then the draft render, sharp and rendered first (live preview, `render` with `quality: \"draft\"`), and `final` " +
      "the blurred one, queued after it (about `samples` times as long): the preview swaps it in once ready, and `render` " +
      "with `quality: \"final\"` or no quality, and `frame`, wait for it. Also present for a clip whose plugin renders finals " +
      "(ADR 0035, Blender: EEVEE draft, Cycles final): its final is rendered only when `render` with `quality: \"final\"` or no " +
      "quality needs it (over 5 minutes estimated asks for `yes`); `frame` and `review` use it when ready, else the draft with a " +
      "warning. Absent: the clip has one render.",
  ),
});

/** ffprobe facts of an asset. */
export const ProbeSchema = z.object({
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
      alpha: z
        .boolean()
        .optional()
        .describe(
          "The picture has an alpha plane (WebM with `alpha_mode`, ProRes 4444, PNG with alpha). Export never crops such a source " +
            "on an upper track to fill another format's frame (ADR 0027); the base track still crops it. Absent in probes cached before it existed.",
        ),
      colorTransfer: z
        .string()
        .nullable()
        .optional()
        .describe(
          "ffprobe `color_transfer` tag of the picture (`bt709`, `smpte2084`, `arib-std-b67`, `log100`...); null when untagged. " +
            "Colour grade warns on HDR and logarithmic curves (ADR 0031). Absent in probes cached before it existed.",
        ),
      colorPrimaries: z
        .string()
        .nullable()
        .optional()
        .describe("ffprobe `color_primaries` tag (`bt709`, `bt2020`...); null when untagged. Absent in probes cached before it existed."),
    })
    .nullable()
    .describe("First video stream; null for audio-only files."),
  audio: z
    .object({ codec: z.string(), sampleRate: z.int(), channels: z.int() })
    .nullable()
    .describe("First audio stream; null when silent."),
});

/** One project asset as the `asset.*` methods report it. */
export const AssetSchema = z.object({
  path: z.string().describe("Project-relative, `/`-separated, e.g. `assets/raw-01.mp4`."),
  kind: z
    .enum(["media", "svg", "font"])
    .describe(
      "`media`: video, audio or image that can be placed as a clip; ingest builds the derived files below. `svg` (`.svg`) and `font` " +
        "(`.ttf`, `.otf`, `.woff`, `.woff2`): not media. Ingest only hashes them, every field below stays null, and `clip.add` refuses them.",
    ),
  hash: z.string().nullable().describe("Content hash `sha256:<hex>`; null until hashed. Transcripts carry it as `assetHash`."),
  state: z
    .enum(["pending", "processing", "ready", "failed"])
    .describe(
      "`ready`: every output below exists for the current content (for `svg` and `font`: the content is hashed). " +
        "`pending`: not ingested yet.",
    ),
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
export const EventNameSchema = z
  .enum(["timeline.changed", "timeline.rejected", "asset.changed", "job.progress", "proposal.changed", "people.changed", "shoot.changed", "target.changed", "beats.changed", "transcription.progress"])
  .describe(
    "`timeline.changed`: a timeline file of the project was changed by an operation (any client, or a direct file edit). " +
      "`timeline.rejected`: a direct edit of a timeline file was refused and the daemon's version restored. " +
      "`proposal.changed`: the project's review-mode proposal opened, grew, became ready, was rebased or closed. " +
      "`people.changed`: a person was added, renamed or removed, a link was added or removed, or a suggestion " +
      "was dismissed (`people.json`). " +
      "`shoot.changed`: a take of a shoot script was added, discarded, chosen or compared, or deviations were accepted (`shoots/*.json`). " +
      "`target.changed`: an agent target of the project registered or left, a reference was queued for it, or it read " +
      "its references (ADR 0025). " +
      "`beats.changed`: a beats file (`beats/*.beats.json`, ADR 0029) was written, edited by hand, deleted or became invalid, so " +
      "a timeline's beat grid may have changed. " +
      "`asset.changed`: an asset's ingest state or derived media changed, or the asset was deleted. " +
      "`job.progress`: a background job (ingest, render, clip) was queued, advanced or finished. " +
      "`transcription.progress`: a `transcribe` request of the project, from any client, started, advanced or ended.",
  );

/** Params of `events.subscribe` and `events.unsubscribe`. */
export const EventsParams = z.strictObject({
  cwd: CwdParam,
  events: z.array(EventNameSchema).min(1).describe("Events to (un)subscribe, e.g. `[\"timeline.changed\"]`."),
});

/** A clip in some timeline file, as `script.outline` links it. */
export const ClipLocationSchema = z.object({
  timeline: z.string().describe("Timeline id (`timelines/<id>.json`)."),
  clip: z.string().describe("Clip id."),
});

/** Where a script scene sits on one timeline, as `script.outline` resolves it: by its words, its linked clips or its heading. */
export const SceneSpanSchema = z.object({
  timeline: z.string().describe("Timeline id (`timelines/<id>.json`)."),
  start: z.number().describe("Timeline seconds where the scene starts: its first placed word, its earliest linked clip, or the planned start."),
  end: z.number().describe("Timeline seconds where the scene ends: its last placed word, its latest linked clip end, or the planned end."),
  words: z.int().describe("Distinct words of the range this timeline places (cut and muted ones are missing; counted once however many tracks place them); 0 for `clips` and `planned`."),
  source: z
    .enum(["words", "clips", "planned"])
    .describe(
      "`words`: the scene's `wordRange` as placed on this timeline. `clips`: the first start to the last end of this timeline's clips linked to the scene " +
        "(a scene whose words are not placed there). `planned`: the time range written in the heading, only for a scene with no clip linked on any timeline, on `main` only.",
    ),
});

/** One export preset as `export.presets` lists it. */
export const ExportPresetResultSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  plugin: z.string().nullable().describe("Package that contributed the preset; null for presets built into Frameshell."),
});

/** A project's copy of the core agent skill against the bundled one. */
export const CoreSkillStateSchema = z.object({
  state: z
    .enum(["current", "outdated", "edited", "absent"])
    .describe(
      "`current`: same as this Frameshell's skill. `outdated`: an older shipped version, unedited; it is updated when " +
        "the project opens. `edited`: someone changed Frameshell's files in it, so it is left alone: `frameshell skill " +
        "update --force` replaces them (files they added stay). `absent`: no copy (deleted or `init --no-skill`).",
    ),
  dir: z.string().describe("Project-relative directory of the copy, `.claude/skills/frameshell`."),
  edited: z.array(z.string()).describe("Files of the copy that differ from every shipped version."),
});

/** Image formats `frame` writes. */
export const FrameFormatSchema = z.enum(["png", "jpg", "webp"]);

/** `frame` quality when the caller gives none: high, visually lossless for most pictures. */
export const DEFAULT_FRAME_QUALITY = 92;

/**
 * Longest cover text, characters. The wire check counts UTF-16 units, so it is never looser than the service's
 * (code points of the upper-cased text, which stays authoritative: `ExportService` in core).
 */
export const COVER_MAX_CHARS = 24;

/** What the cover word and its frame are chosen by; shared by `cover` and the `cover` option of `render`. */
export const CoverChoiceShape = {
  text: z
    .string()
    .min(1)
    .max(COVER_MAX_CHARS)
    .optional()
    .describe(
      `The word drawn big over the frame (up to ${COVER_MAX_CHARS} characters; shown upper-case, one line, as large as the width allows). ` +
        "Absent: the frame alone. Without `at`, the frame is the one where this word is first spoken.",
    ),
  at: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Timeline seconds of the frame to use. Default: where `text` is first spoken (in the transcripts of the video and audio tracks), " +
        "else the first frame showing a whole picture (after the first clip's fade in).",
    ),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Word colour, `#rrggbb`; the outline turns black or white to contrast with it. Default yellow `#ffd426`."),
};

/** `preset` param of export methods. */
export const PresetParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Export preset id from `export.presets`, e.g. `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920`, `gif`. " +
      "Default: `export.defaultPreset` in `frameshell.json`, else `youtube-1080p`. A preset given here must have the " +
      "aspect of every format rendered and sets the output size (a `fit: \"inside\"` preset such as `gif` fits every format inside its box); " +
      "a default preset only gives codec, bitrate and loudness when its aspect differs (ADR 0027).",
  );

/** Quality tiers a `render` can ask for; the other tiers (`master`, `preview`) are for intermediates. */
export const RenderQualityParam = QualityTierSchema.extract(["draft", "final"])
  .optional()
  .describe(
    "Quality tier. `draft`: for review rounds, at most 30 fps, x264 CRF 22 veryfast (or the machine's hardware " +
      "encoder), much faster than a final. `final`: CRF 16 slow, bt709 tags, faststart, the delivery. Both use the " +
      "encoder `doctor` reports (first of VideoToolbox, NVENC, x264 that works on this machine) and replace the " +
      "preset's own `crf`/`bitrateKbps`; only H.264 presets take a tier (others render as the preset says, with a " +
      "warning). Default: the preset as written (x264, its own CRF).",
  );

/** One format of a project as `format.*` report it (ADR 0027). */
export const FormatInfoSchema = z.object({
  id: z.string().describe("Format id, e.g. `16x9`, `9x16`, `web-1600x900`."),
  width: z.int(),
  height: z.int(),
  primary: z.boolean().describe("The first format: equals `resolution`, rendered when `render` gets no `formats`."),
  builtin: z.boolean().describe("A built-in id (`16x9`, `1x1`, `4x5`, `9x16`) with its fixed canvas."),
});

/**
 * What a `format.add` or `format.remove` changed, and how to undo it.
 * Typed explicitly: inferred, it pushes the `methods` registry past the declaration size the compiler can print.
 */
export const FormatChangeSchema: z.ZodType<FormatChange> = z.object({
  dir: z.string().describe("Project root."),
  formats: z
    .array(FormatInfoSchema)
    .describe("The project's formats after the change, primary first; in review mode, the proposal's version (the file is unchanged)."),
  op: z.string().describe("Journal id of the change in `.frameshell/history/project.config.jsonl`, `op_…`; `revert` takes it."),
  tx: TxIdSchema.describe("Transaction the change joined (ADR 0036); `revert` with it undoes the whole transaction."),
  undo: z
    .object({ method: z.enum(["format.add", "format.remove"]), params: z.record(z.string(), z.unknown()) })
    .describe("The call that undoes this change (with `cwd` added), e.g. `format.remove` with `{ id: \"9x16\" }`."),
  proposal: TxIdSchema.nullable().describe(
    "Review mode (ADR 0019): the proposal now holding the change, which reaches `frameshell.json` only once the person accepts it " +
      "(`proposal.wait`). Null: applied at once.",
  ),
});

/**
 * What a `style.set` or `style.apply` changed (ADR 0028, ADR 0036).
 * Typed explicitly: inferred, it pushes the `methods` registry past the declaration size the compiler can print.
 */
export const StyleChangeSchema: z.ZodType<StyleChange> = z.object({
  dir: z.string().describe("Project root."),
  path: z.string().describe("The style file, project-relative: `style.json`."),
  changes: z
    .array(
      z.object({
        path: z.string().describe("Dotted path of the value, e.g. `colors.accent`; `from` for the user style it was copied from."),
        before: z.unknown().describe("Value in the file before; null when it was not set."),
        after: z.unknown().describe("Value in the file after; null when it is no longer set."),
      }),
    )
    .describe("Every value that changed, in schema order; empty when the file already held them."),
  op: z.string().describe("Journal id of the change in `.frameshell/history/project.config.jsonl`, `op_…`; `revert` takes it."),
  tx: TxIdSchema.describe("Transaction the change joined (ADR 0036); `revert` with it undoes the whole transaction."),
  proposal: TxIdSchema.nullable().describe(
    "Review mode (ADR 0019): the proposal now holding the change, which reaches `style.json` only once the person accepts it " +
      "(`proposal.wait`). Null: applied at once.",
  ),
});

/** One file `render` writes: the export of one format. */
export const RenderOutputSchema = z.object({
  format: z.string().describe("Format id rendered, e.g. `9x16`."),
  job: JobSchema,
  output: z.string().describe("Absolute path the file is written to."),
  preset: z.string().describe("Preset id used: its codec, bitrate and loudness, and its size when it has the format's aspect."),
  width: z.int(),
  height: z.int(),
  segments: z.int().describe("Video segments encoded in parallel."),
  warnings: z.array(z.string()).describe("Timeline content this export does not render, and a default preset whose size the format overrode; empty when none."),
});

/** What `review` found on one rendered row of a batch (ADR 0040, `batch.render` with `review`). */
export const BatchReviewSchema = z.object({
  state: z.enum(["pending", "done", "error"]).describe("`pending` until the render is done and its review ran; `error` when the review could not run (see `error`)."),
  verdict: z
    .enum(["pass", "warn", "fail"])
    .nullable()
    .describe("`fail` when `requirements.json` fails (`failed` > 0), else `warn` when `metrics.craft` holds a warning, else `pass`; null until the review ran."),
  warnings: z.int().describe("Craft warnings left in `metrics.craft` (waived ones are not counted)."),
  failed: z.int().describe("`requirements.failed` of the review: checks that failed plus craft warnings of severity `fail`; 0 without a `requirements.json`."),
  checks: z.array(z.string()).describe("Craft check ids of the warnings, e.g. `static`, `peak`; each once."),
  run: z.int().nullable().describe("`review` run number: the sheets and `metrics.json` are in `<project>/.frameshell/review/<run>/`; null until it ran."),
  error: z.string().nullable().describe("Why the review could not run; null otherwise."),
});

/** One row × format of a batch (ADR 0040), as `batch.render` returns it and `<out>/manifest.json` keeps it. */
export const BatchEntrySchema = z.object({
  row: z.string().describe("Row id of the batch file."),
  format: z.string().describe("Format id rendered, e.g. `9x16`."),
  output: z.string().describe("Absolute file the render writes: `<out>/<row>.<container>`, with `-<format>` when the batch lists formats."),
  status: z
    .enum(["planned", "queued", "running", "done", "failed", "canceled"])
    .describe("`planned` only in a dry run; then `queued` until its row's turn, `running`, and `done`, `failed` or `canceled`."),
  job: z.string().nullable().describe("Render job id (`job.list`) once the row is queued; null before."),
  error: z.string().nullable().describe("Why the render failed; null otherwise."),
  startedAt: z.string().nullable().describe("ISO time the render started; null before."),
  finishedAt: z.string().nullable().describe("ISO time it ended; null before."),
  duration: z.number().nullable().describe("Seconds the render took; null until it ended."),
  warnings: z.array(z.string()).describe("What this render skips, and assets of the row without verified provenance (ADR 0026)."),
  hash: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Fingerprint of the data this render was made from: the row's cells, the batch file's slots and the template timeline's content. " +
        "A later run renders a `done` row again, reported in `changed`, when it differs; null in a manifest of an older version, which a run treats as unchanged.",
    ),
  review: BatchReviewSchema.nullable()
    .default(null)
    .describe("The review of the rendered file (`batch.render` with `review`); null when the batch did not ask for one, the render has not ended `done` or a manifest of an older version has none."),
});

/** `<out>/manifest.json` of a batch (ADR 0040): one entry per row × format, rewritten atomically on each job change. */
export const BatchManifestSchema = z.object({
  batch: z.string().describe("Absolute path of the batch file."),
  template: z.string().describe("Template timeline id."),
  out: z.string().describe("Absolute folder of the outputs and this manifest."),
  state: z
    .enum(["running", "done", "canceled"])
    .describe("`done` once every entry ended; `canceled` once `batch.cancel` stopped it and the running render ended; `running` left behind means the daemon stopped mid-batch."),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  entries: z.array(BatchEntrySchema).describe("Row order, then format order."),
});

/** Where a checked word sits: shared by lost and uncertain words of `transcribe.verify`. */
export const VerifiedWordSchema = z.object({
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

/** A kept word not heard at all in the export (`transcribe.verify`). */
export const LostWordSchema = VerifiedWordSchema.describe(
  "A word kept by the timeline that the cut falls inside (`clipped` is always true), of which nothing was heard in the " +
    "export, not even when the audio around it was re-transcribed alone.",
);

/** A kept word heard doubtfully in the export (`transcribe.verify`). */
export const UncertainWordSchema = VerifiedWordSchema.extend({
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

/** Fields every sound of `sound.place` takes, whichever way its time is given (ADR 0038). */
export const soundFields = {
  role: SoundRoleSchema.optional().describe("What the sound does to the picture; it picks the offset against the cue. Default: by kind."),
  tier: SoundTierSchema.optional().describe("`primary` (carries the picture), `secondary`, `texture` (background); it picks the gain. Default: by kind."),
  seed: z.number().int().min(0).max(SFX_SEED_MAX).default(0).describe("Family seed, as in `sound.sfx`: one seed per film keeps one timbre."),
  pitch: z.number().min(SFX_PITCH_RANGE.min).max(SFX_PITCH_RANGE.max).optional().describe("Multiplier of every frequency, as in `sound.sfx`."),
  offset: z.number().min(-1000).max(1000).optional().describe("Milliseconds from the cue to the take's anchor, replacing the role's offset (negative = before the picture)."),
  gain: z.number().min(-60).max(12).optional().describe("Clip gain in dB, replacing the one from the style and the tier."),
};

/** The fields of a sound that has a kind of its own. */
export const soundKindFields = {
  kind: SfxKindSchema.describe("What the sound is, as in `sound.sfx`."),
  variant: z.number().int().min(1).max(SFX_VARIANTS).optional().describe(`Recipe of the kind, 1 to ${SFX_VARIANTS}. Default: rotates through them along the timeline.`),
  length: z.number().positive().optional().describe("Seconds, for `whoosh` and `riser` only, as in `sound.sfx`."),
};

/** One sound of `sound.place` `cues`. */
export const SoundCueSchema = z.strictObject({
  at: TimeRefParam("Timeline time of the picture event the sound belongs to."),
  ...soundKindFields,
  ...soundFields,
});

/** `cuts` of `sound.place`. */
export const SoundCutsSchema = z.strictObject({
  track: z.string().min(1).describe("Video or audio track whose cuts (the start of every clip after the first) get a sound, from `track.list`."),
  which: z.array(z.int().min(1)).min(1).optional().describe("Only these cuts, counted from 1 in time order. Default: every cut."),
  ...soundKindFields,
  ...soundFields,
});

/** `typing` of `sound.place`. */
export const SoundTypingSchema = z.strictObject({
  from: TimeRefParam("Timeline time of the first key."),
  to: TimeRefParam("Timeline time the run ends; no key at or after it. After `from`."),
  rate: z
    .number()
    .positive()
    .max(SOUND_TYPING_RATE.max)
    .default(SOUND_TYPING_RATE.default)
    .describe(`Keys per second, at most ${SOUND_TYPING_RATE.max}. Default ${SOUND_TYPING_RATE.default}.`),
  kind: z.enum(["tick", "click"]).default("tick").describe("`tick` (default) or `click`."),
  ...soundFields,
});
