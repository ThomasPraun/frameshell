import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentLabelSchema } from "./agents.js";
import {
  CLEANUP_BREATH_DEFAULT_S,
  CLEANUP_MIN_CONFIDENCE_DEFAULT,
  CLEANUP_PAUSES_DEFAULT_S,
  CleanupResultSchema,
} from "./cleanup.js";
import { ClipVerifyResultSchema, VERIFY_DEFAULT_PROBES, VERIFY_DEFAULT_TOLERANCE, VERIFY_MAX_PROBES } from "./clip-verify.js";
import { MUSIC_CANDIDATES_MAX, MusicCandidatesResultSchema, MusicFitResultSchema, MusicShapeResultSchema } from "./music.js";
import { ProposalConfigChangeSchema } from "./config.js";
import { ConfigOperationSchema, HistoryDiffResultSchema, HistoryResultSchema, OpenTransactionSchema, TransactionInfoSchema } from "./history.js";
import {
  ProposalOutcomeSchema,
  ProposalSchema,
  ProposalStateSchema,
  ReviewStateSchema,
  TimelineViewNameSchema,
  ViewedShape,
} from "./proposals.js";
import { ModelIdSchema, ModelListResultSchema, RegisteredModelSchema } from "./models.js";
import { ShootChangedSchema, ShootSceneStatusSchema, TakeInfoSchema } from "./shoot.js";
import {
  AgentClientSchema,
  AgentTargetKindSchema,
  AgentTargetSchema,
  INBOX_WAIT_DEFAULT_S,
  INBOX_WAIT_MAX_S,
  InboxTakeResultSchema,
  TargetChangedSchema,
} from "./targets.js";
import { BrandCaptureResultSchema } from "./brand.js";
import { CreditAssetSchema, ProvenanceParams } from "./credits.js";
import { AnalyzeDiffResultSchema, AnalyzeResultSchema } from "./analyze.js";
import { ReviewOutputSchema, ReviewResultSchema } from "./review.js";
import { FacePointSchema, PeopleChangedSchema, PeopleScanResultSchema, PeopleSuggestionSchema, PersonInfoSchema, PersonTargetParams } from "./people.js";
import { AudioEffectSchema, BeatsEditsSchema, CreditEntrySchema, DIRECTOR_TEMPLATE_IDS, FormatIdSchema, MAX_SOURCE_URL, MUSIC_BPM_RANGE, MUSIC_CHORD_PATTERN, MUSIC_LIMITS, MUSIC_LUFS, MUSIC_MAX_BARS, MUSIC_MAX_SECONDS, MUSIC_METER_RANGE, MUSIC_PEAK_DBFS, MUSIC_PRESET_DEFAULTS, MUSIC_TAIL_SECONDS, MusicPresetSchema, MusicSectionSchema, ResolvedStyleSchema, SFX_JITTER, SFX_LENGTH_RANGE, SFX_PITCH_RANGE, SFX_SEED_MAX, SFX_VARIANTS, SOUND_KEY_GAP_MS, SOUND_MAX_PER_FRAME, SOUND_MAX_PLACEMENTS, SOUND_MIN_GAP_MS, SOUND_RISER_END_BEFORE_MS, SOUND_ROLE_OFFSETS, SOUND_TIER_OFFSETS_DB, SOUND_TYPING_RATE, SafeZoneSchema, ScriptMetaSchema, ScriptSceneSchema, SessionSoundSchema, SfxKindSchema, ShootMetaSchema, SoundRoleSchema, SoundTierSchema, ShootSceneSchema, ShootSessionIdSchema, TempoSchema, UserStyleIdSchema, VOICEOVER_LINE_GAP_S, VoiceoverLineSchema } from "@frameshell/schema";
import {
  MarkerListResultSchema,
  CaptionsSetResultSchema,
  MulticamCreateResultSchema,
  MulticamDirectResultSchema,
  ClipReframeResultSchema,
  MulticamFacesResultSchema,
  MulticamGalleryResultSchema,
  MulticamTurnsResultSchema,
  OpIdSchema,
  OperationResultSchema,
  RejectionRecordSchema,
  TimeRefParam,
  TimelineIdSchema,
  TimelineProblemSchema,
  TimelineRejectionSchema,
  TempoGridSchema,
  TimelineViewSchema,
  TimeRef,
  TrackDuckResultSchema,
  TrackSummarySchema,
  TxIdSchema,
  operationArgs,
} from "./timeline.js";
import {
  InspectedPointSchema,
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
export const PROTOCOL_VERSION = 132;

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

const EncoderNameSchema = z
  .enum(["h264_videotoolbox", "h264_nvenc", "libx264"])
  .describe("H.264 encoder, in the order tried: VideoToolbox (macOS), NVENC (NVIDIA), x264 (software, always the last resort).");

const QualityTierSchema = z
  .enum(["master", "preview", "draft", "final"])
  .describe(
    "Encode quality tier. `master`: intermediates kept for later passes (x264 CRF 16 medium). `preview`: throwaway " +
      "looks (CRF 26 veryfast). `draft`: review rounds (30 fps at most, CRF 22 veryfast). `final`: the delivery " +
      "(CRF 16 slow, bt709 tags, faststart). Hardware encoders use their own equivalent settings.",
  );

const EncoderReportSchema = z.object({
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

const MachineProfileSchema = z.object({
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
    .enum(["proxy", "sidecar", "manifest", "waveform", "thumbnails", "energy", "loudness", "beats", "audio", "audio-fx", "voice", "clip", "context", "proposal", "people", "shoot", "matte", "temp"])
    .describe(
      "`proxy`, `sidecar`, `manifest`, `waveform`, `thumbnails`: ingest outputs of content no asset has now (or of an " +
        "older recipe or fps). `energy`: cut-snapping envelope. `loudness`: EBU R128 reading of an asset in `.frameshell/loudness/` (content no asset has now). `beats`: onset envelope of the beat detector in `.frameshell/beats/` (the grids in `beats/` are project files and never deleted). `audio`: WAV extracted for transcription. `audio-fx`: baked " +
        "audio effects in `.frameshell/audio-fx/` no clip of any timeline plays now (ADR 0031). `voice`: " +
        "voice prints in `.frameshell/people/voices/` of content no asset has now. `clip`: " +
        "generated-clip render no timeline uses. `context`: \"Chat about this\" frame capture or pick details in " +
        "`.frameshell/context/`, older than 7 days. `proposal`: rejected, stale or aborted review-mode proposal in " +
        "`.frameshell/proposals/`, decided more than 7 days ago. `people`: face scan of content no asset has now (or of " +
        "other models) in `.frameshell/people/`. `shoot`: take comparison of a script or transcript that changed since, in " +
        "`.frameshell/shoot/`. `matte`: subject matte in `.frameshell/cache/mattes/` of content no asset has now (or of " +
        "another model, fps or matte version). `temp`: leftover of an interrupted job or transcription.",
    ),
  bytes: z.int().describe("Size on disk; a directory counts its files."),
});

const BeatsSummarySchema = z.object({
  asset: z.string().describe("Project-relative asset path."),
  file: z.string().describe("Project-relative beats file, e.g. `beats/theme.beats.json`."),
  hash: z.string().describe("`sha256:<hex>` of the asset's content the grid was measured from."),
  detector: z.string().describe("`onset-flux@1`, or `exact` for a grid a generator wrote."),
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

const GcSkipSchema = z.object({
  area: z
    .enum(["media", "clips", "audio", "audio-fx", "temp"])
    .describe("What was left alone: derived media, the clip render cache, transcription WAVs, baked audio effects, or job temp files."),
  reason: z.string(),
});

const CwdParam = AbsolutePath.describe(
  "Absolute directory inside the project, e.g. `/home/ana/videos/launch`. The project is found searching upwards.",
);

/** `view` of the reads review mode (ADR 0019) affects. */
const ViewParam = TimelineViewNameSchema.optional();

/** Default and longest `proposal.wait` in seconds. */
export const PROPOSAL_WAIT_DEFAULT_S = 300;
/** See {@link PROPOSAL_WAIT_DEFAULT_S}. */
export const PROPOSAL_WAIT_MAX_S = 3600;

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
      speechProviders: z.array(z.string()).describe("Speech providers for `voiceover.generate` (ADR 0034)."),
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
const AudioBakeSchema = z.object({
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
const MatteStateSchema = z.object({
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

const AssetSchema = z.object({
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
const EventNameSchema = z
  .enum(["timeline.changed", "timeline.rejected", "asset.changed", "job.progress", "proposal.changed", "people.changed", "shoot.changed", "target.changed", "beats.changed"])
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

/** Where a script scene's words sit on one timeline, as `script.outline` resolves them. */
const SceneSpanSchema = z.object({
  timeline: z.string().describe("Timeline id (`timelines/<id>.json`)."),
  start: z.number().describe("Timeline seconds where the first placed word of the range starts."),
  end: z.number().describe("Timeline seconds where the last placed word of the range ends."),
  words: z.int().describe("Distinct words of the range this timeline places (cut and muted ones are missing; counted once however many tracks place them)."),
});

const ExportPresetResultSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  plugin: z.string().nullable().describe("Package that contributed the preset; null for presets built into Frameshell."),
});

/** A project's copy of the core agent skill against the bundled one (#396). */
const CoreSkillStateSchema = z.object({
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
const FrameFormatSchema = z.enum(["png", "jpg", "webp"]);

/** `frame` quality when the caller gives none: high, visually lossless for most pictures. */
export const DEFAULT_FRAME_QUALITY = 92;

/**
 * Longest cover text, characters. The wire check counts UTF-16 units, so it is never looser than the service's
 * (code points of the upper-cased text, which stays authoritative: `ExportService` in core).
 */
export const COVER_MAX_CHARS = 24;

/** What the cover word and its frame are chosen by; shared by `cover` and the `cover` option of `render`. */
const CoverChoiceShape = {
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

const PresetParam = z
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
const RenderQualityParam = QualityTierSchema.extract(["draft", "final"])
  .optional()
  .describe(
    "Quality tier. `draft`: for review rounds, at most 30 fps, x264 CRF 22 veryfast (or the machine's hardware " +
      "encoder), much faster than a final. `final`: CRF 16 slow, bt709 tags, faststart, the delivery. Both use the " +
      "encoder `doctor` reports (first of VideoToolbox, NVENC, x264 that works on this machine) and replace the " +
      "preset's own `crf`/`bitrateKbps`; only H.264 presets take a tier (others render as the preset says, with a " +
      "warning). Default: the preset as written (x264, its own CRF).",
  );

/** One format of a project as `format.*` report it (ADR 0027). */
const FormatInfoSchema = z.object({
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
const FormatChangeSchema: z.ZodType<FormatChange> = z.object({
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
const StyleChangeSchema: z.ZodType<StyleChange> = z.object({
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
const RenderOutputSchema = z.object({
  format: z.string().describe("Format id rendered, e.g. `9x16`."),
  job: JobSchema,
  output: z.string().describe("Absolute path the file is written to."),
  preset: z.string().describe("Preset id used: its codec, bitrate and loudness, and its size when it has the format's aspect."),
  width: z.int(),
  height: z.int(),
  segments: z.int().describe("Video segments encoded in parallel."),
  warnings: z.array(z.string()).describe("Timeline content this export does not render, and a default preset whose size the format overrode; empty when none."),
});

/** One row × format of a batch (ADR 0040), as `batch.render` returns it and `<out>/manifest.json` keeps it. */
const BatchEntrySchema = z.object({
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
});

/** `<out>/manifest.json` of a batch (ADR 0040): one entry per row × format, rewritten atomically on each job change. */
export const BatchManifestSchema = z.object({
  batch: z.string().describe("Absolute path of the batch file."),
  template: z.string().describe("Template timeline id."),
  out: z.string().describe("Absolute folder of the outputs and this manifest."),
  state: z.enum(["running", "done"]).describe("`done` once every entry ended; `running` left behind means the daemon stopped mid-batch."),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  entries: z.array(BatchEntrySchema).describe("Row order, then format order."),
});

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

/** Fields every sound of `sound.place` takes, whichever way its time is given (ADR 0038). */
const soundFields = {
  role: SoundRoleSchema.optional().describe("What the sound does to the picture; it picks the offset against the cue. Default: by kind."),
  tier: SoundTierSchema.optional().describe("`primary` (carries the picture), `secondary`, `texture` (background); it picks the gain. Default: by kind."),
  seed: z.number().int().min(0).max(SFX_SEED_MAX).default(0).describe("Family seed, as in `sound.sfx`: one seed per film keeps one timbre."),
  pitch: z.number().min(SFX_PITCH_RANGE.min).max(SFX_PITCH_RANGE.max).optional().describe("Multiplier of every frequency, as in `sound.sfx`."),
  offset: z.number().min(-1000).max(1000).optional().describe("Milliseconds from the cue to the take's anchor, replacing the role's offset (negative = before the picture)."),
  gain: z.number().min(-60).max(12).optional().describe("Clip gain in dB, replacing the one from the style and the tier."),
};

/** The fields of a sound that has a kind of its own. */
const soundKindFields = {
  kind: SfxKindSchema.describe("What the sound is, as in `sound.sfx`."),
  variant: z.number().int().min(1).max(SFX_VARIANTS).optional().describe(`Recipe of the kind, 1 to ${SFX_VARIANTS}. Default: rotates through them along the timeline.`),
  length: z.number().positive().optional().describe("Seconds, for `whoosh` and `riser` only, as in `sound.sfx`."),
};

/** One sound of `sound.place` `cues`. */
const SoundCueSchema = z.strictObject({
  at: TimeRefParam("Timeline time of the picture event the sound belongs to."),
  ...soundKindFields,
  ...soundFields,
});

/** `cuts` of `sound.place`. */
const SoundCutsSchema = z.strictObject({
  track: z.string().min(1).describe("Video or audio track whose cuts (the start of every clip after the first) get a sound, from `track.list`."),
  which: z.array(z.int().min(1)).min(1).optional().describe("Only these cuts, counted from 1 in time order. Default: every cut."),
  ...soundKindFields,
  ...soundFields,
});

/** `typing` of `sound.place`. */
const SoundTypingSchema = z.strictObject({
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
      codecs: z
        .array(CodecReportSchema)
        .describe("Empty when ffmpeg is not installed or not runnable."),
      encoders: EncoderReportSchema.nullable().describe("H.264 encoder choice; null when ffmpeg is not installed or not runnable."),
      profile: MachineProfileSchema.describe("Speed class and recommended sizes of this machine."),
      problems: z.array(z.string()).describe("Actionable issues; empty when everything needed works."),
      skill: CoreSkillStateSchema.nullable().describe("The project's copy of the agent skill; null when `cwd` is in no project."),
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
  "export.presets": {
    description:
      "List the export presets available in the enclosing project: the built-in ones (`youtube-1080p`, `youtube-1440p`, " +
      "`vertical-1080x1920`, `gif`) and those contributed by its trusted plugins. A preset's `container` is `mp4`, `mov`, `webm` or " +
      "`gif`; a `gif` preset (codec `gif`) has no `audio`, and `video.fit: \"inside\"` makes its `width` x `height` a box the format's frame is fitted inside.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      presets: z
        .array(ExportPresetResultSchema)
        .describe("Declarative presets: `container`, `video` (codec, width, height…), `audio`, `loudness` (LUFS)."),
    }),
  },
  "format.list": {
    description:
      "List the delivery formats of the enclosing project (ADR 0027), primary first: one edit renders at each size. " +
      "A project without `formats` in `frameshell.json` has one, its `resolution`. `builtins` lists the ids `format.add` " +
      "takes without a size. While a review-mode proposal changes the formats (ADR 0036), `view: \"proposal\"` lists its version.",
    params: z.strictObject({ cwd: CwdParam, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
      dir: z.string().describe("Project root."),
      formats: z.array(FormatInfoSchema).describe("Primary first."),
      builtins: z.array(FormatInfoSchema).describe("Built-in formats `16x9`, `1x1`, `4x5`, `9x16` with their canvases."),
    }),
  },
  "format.add": {
    mutating: true,
    description:
      "Add a delivery format to the enclosing project's `formats` in `frameshell.json` (ADR 0027), e.g. `{ id: \"9x16\" }`, " +
      "then `render` with `formats: [\"16x9\", \"9x16\"]` exports every one from the same edit. Built-in ids (`16x9` " +
      "1920x1080, `1x1` 1080x1080, `4x5` 1080x1350, `9x16` 1080x1920) take no size; a custom id needs `width` and `height` " +
      "(even), e.g. `{ id: \"web-1600x900\", width: 1600, height: 900 }`. In a format other than the primary, media clips " +
      "with no transform or keys fill the frame (cropped around the centre), generated clips render at the format's size, " +
      "vertical captions are 1.3x larger. The change is journaled in `.frameshell/history/project.config.jsonl` in the " +
      "caller's transaction (ADR 0036): `history` lists it, `revert` with its `op` or `tx` undoes it, and `undo` names the " +
      "call that reverses it. While review mode is on (ADR 0019), a change by anyone but the person in the app waits in " +
      "the transaction's proposal like a timeline change (`proposal` in the result; `frameshell.json` is unchanged until the " +
      "person accepts it). Fails with InvalidOperation (id taken, size missing or odd, a built-in id with another size, an " +
      "image project), ProposalPending (another proposal waits: `proposal.wait`), ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      id: FormatIdSchema,
      width: z.int().positive().optional().describe("Frame width in pixels, even. Only for a custom id; a built-in id has its own."),
      height: z.int().positive().optional().describe("Frame height in pixels, even. Only for a custom id."),
      index: z
        .int()
        .min(1)
        .optional()
        .describe("Position in the list, 1 = right after the primary (which always stays first). Default: last."),
    }),
    result: FormatChangeSchema,
  },
  "format.remove": {
    mutating: true,
    description:
      "Remove a delivery format from the enclosing project's `formats` (ADR 0027). The primary format (the first, equal " +
      "to `resolution`) cannot be removed. Removing the last other format leaves `frameshell.json` without `formats`. " +
      "Cached renders of generated clips at its size become unused (`gc` deletes them). Journaled like `format.add`; " +
      "`revert` or `undo` re-adds it at the same position. Held by review mode like `format.add`. Fails with FormatNotFound, " +
      "InvalidOperation (the primary), ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({ cwd: CwdParam, id: FormatIdSchema }),
    result: FormatChangeSchema,
  },
  render: {
    mutating: true,
    description:
      "Export a timeline to a video file (SPEC §3.5) as a background job, and return at once with the job. Video is " +
      "encoded in segments in parallel and joined; audio is mixed in one continuous pass with a 2 ms fade at every cut, " +
      "`atempo` for clip speed, then two-pass loudness normalization to the target (preset `loudness`, else " +
      "`export.loudness` in `frameshell.json`, else -17 LUFS integrated). Follow the job with `job.list` until it is " +
      "`done` (the file exists at `output`) or `failed` (`error` says why), or subscribe to `job.progress`. Renders from the original assets, not " +
      "proxies, and never waits for ingest. Export v1 renders the first video track (media clips, gaps in black), multicam " +
      "program tracks (every shot's angles in their tiles) and the sound of every video, audio and program track; `warnings` lists what it skipped (subtitles, transforms). Fails with " +
      "PresetNotFound, ExportUnsupported (empty timeline, clips on a second video track, nested timelines or adapter " +
      "clips, a multicam group missing, a program track nested under a transformed clip), TimelineNotFound, AssetNotFound. " +
      "Formats (ADR 0027): `formats` renders the edit once per listed format of the project (`format.list`), one job each, " +
      "the file of each named `<name>-<format>.<container>`; `renders` lists them, and the top-level fields describe the first. " +
      "In a format other than the primary, untransformed media fills the frame (crop around the centre), generated clips " +
      "render at that size first, and vertical captions are 1.3x larger. A `preset` whose aspect differs from a format " +
      "rendered fails with InvalidOperation; FormatNotFound names the project's formats. " +
      "Loop (ADR 0039): `loop: true` makes the file loop without a seam: the last frame must not repeat frame 0 (a loop is a first key " +
      "identical to the last, with the frame range leaving the duplicate out), MP4 and MOV audio gets a 2 ms half-sine fade at its first " +
      "and last sample, and `warnings` says when the output frame rate breaks the cycle or an end fades from or to black. Once the file is " +
      "written the job compares frame 0 with the last frame and puts a warning in the job's `warnings` when they are the same picture. " +
      "The timeline is never changed. Fails with InvalidOperation when combined with `cover`. " +
      "GIF (ADR 0039): `preset: \"gif\"` writes a looping GIF (`exports/<timeline>-gif.gif`): no sound, each format fitted inside 1200x1200 " +
      "(16:9 is 1200x675, 9:16 is 675x1200, never scaled up), at most 30 fps (24 and 25 keep their rate), one palette over the whole file with " +
      "bayer dither, ~4 centisecond frame delays. A GIF always has the loop rules (refused with `cover`, the black-end and cycle warnings, the " +
      "repeated-last-frame warning on the job) and ignores `quality` (a warning says so). More than 350 output frames fails with InvalidOperation " +
      "(`data.frames`, `data.max`) before anything is queued; a finished file over 15 MB puts a warning in the job's `warnings`.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      preset: PresetParam,
      formats: z
        .array(FormatIdSchema)
        .min(1)
        .optional()
        .describe(
          "Format ids to render, e.g. `[\"16x9\", \"9x16\"]`; each must be in `format.list`. Each file gets the format id " +
            "as suffix. Default: the primary format only, file named as before.",
        ),
      quality: RenderQualityParam,
      out: AbsolutePath.optional().describe(
        "Absolute output file, e.g. `/home/ana/videos/launch/exports/launch.mp4`; its folder is created. " +
          "Default `<project>/exports/<timeline>-<preset>.<container>`. With `formats`, `-<format>` is added before the " +
          "extension of each file. An existing file is replaced when the job finishes.",
      ),
      cover: z
        .strictObject(CoverChoiceShape)
        .optional()
        .describe(
          "Make frame 0 a finished composition (platforms show it as the thumbnail): the frame chosen like `cover` does, with " +
            "its word over it, replaces the first frame only; no subtitles on it, nothing else changes. Absent: frame 0 is the " +
            "timeline's own, and `warnings` says when that is black. Needs the preset's frame rate to equal the project's.",
        ),
      loop: z
        .boolean()
        .optional()
        .describe(
          "Export a file meant to repeat (title loops, banners): frame 0 to the last frame, 2 ms half-sine audio fades at both ends of " +
            "MP4 and MOV, warnings for a broken cycle, black ends, and a last frame that repeats frame 0. Refused with `cover`. Default false.",
        ),
    }),
    result: z.object({
      format: z.string().describe("Format id of the first render, which the fields below describe."),
      renders: z.array(RenderOutputSchema).describe("One per format rendered, in the order asked; the first is the one above."),
      job: JobSchema,
      output: z.string().describe("Absolute path the file is written to."),
      preset: z.string().describe("Preset id used."),
      quality: QualityTierSchema.extract(["draft", "final"]).nullable().describe("Tier asked for; null = the preset as written."),
      encoder: z.string().describe("ffmpeg video encoder of the segments, e.g. `libx264`, `h264_videotoolbox`."),
      timeline: z.string(),
      duration: z.number().describe("Seconds rendered (timeline duration)."),
      width: z.int(),
      height: z.int(),
      fps: z.string().describe("Output frame rate as a rational, e.g. `30/1` or `30000/1001`."),
      loudness: z.number().describe("Integrated loudness target, LUFS."),
      segments: z.int().describe("Video segments encoded in parallel."),
      warnings: z.array(z.string()).describe("Timeline content this export does not render, and a default preset whose size the format overrode; empty when none."),
    }),
  },
  "batch.render": {
    mutating: true,
    description:
      "Render variants of one template timeline from data rows (ADR 0040): sizes, languages, product rows. The batch file " +
      "(`*.batch.json`, JSON Schema `batch.json`) names `template` (timeline id, default `main`), `slots` (name → " +
      "`<clipId>.props.<dot.path>` or `<clipId>.asset`), `rows` (`{ id, <slot>: value }`, ids lowercase `[a-z0-9-]`, unique, " +
      "used as file names; a slot a row leaves out keeps the template's value), and optional `formats`, `preset`, `quality`. " +
      "Each row patches the template in memory only, never under `timelines/` (no journal, no proposal): a props value is " +
      "written at its path over the clip's props and checked by the adapter like `clip.set`; an asset swap keeps the clip's " +
      "in, out and placement and fails when the new file lacks the stream the track plays, is shorter than `out`, or lacks a " +
      "transcript a subtitle track follows. Every row × format is validated and compiled first; then the rows render one at a " +
      "time as ordinary `render` jobs, to `<out>/<row>.<container>` (`-<format>` added with formats), and the call returns at " +
      "once. `<out>/manifest.json` (default `<project>/exports/<batch file name>/`) holds every row × format with status, " +
      "output, job, error and timings, rewritten on each job change; follow the jobs with `job.list` or `job.progress`. " +
      "Formats come from `frameshell.json` on disk, never a pending proposal. Batch never generates voiceover: swap in takes " +
      "that exist. `dryRun` validates and returns the plan without rendering. Fails with InvalidOperation (data `{ row, slot }`: " +
      "unknown clip, props the adapter refuses, an asset too short or without the stream or transcript; a batch already " +
      "running into the same `out`; a name in `rows` the file lacks; `failed` without a manifest of this batch file), " +
      "InvalidProjectFile (the batch file), and what `render` fails with, its data naming the `row`. Re-run: `rows` " +
      "(row ids, or `first..last` for the rows from one to the other in file order) renders only those rows, `failed` " +
      "only rows with an entry in the manifest that is not `done` (failed, canceled, or left `queued`/`running` when " +
      "the daemon stopped) or no entry yet; both together = the failed ones among `rows`. Only the chosen rows are " +
      "validated, so a bad row elsewhere does not block them; the other rows keep their manifest entries. A chosen row " +
      "whose entries are all `done` with the files still there is skipped (listed in `skipped`) unless `force`: edit " +
      "a row, then pass `force` or its id in `rows` with `force`.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("Batch file, absolute or relative to `cwd`, e.g. `batches/launch.batch.json`."),
      out: AbsolutePath.optional().describe("Absolute folder for the outputs and `manifest.json`. Default `<project>/exports/<batch file name without .batch.json>/`."),
      formats: z
        .array(FormatIdSchema)
        .min(1)
        .optional()
        .describe("Format ids to render each row in, instead of the batch file's `formats`; each must be in `format.list`."),
      rows: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Render only these rows: row ids, or `first..last` for the rows from `first` to `last` in the file's order (ids never hold `.`). Default every row."),
      failed: z
        .boolean()
        .default(false)
        .describe("Only rows whose manifest entries are not all `done` (failed, canceled, left queued or running by a stopped daemon) or that have none; needs `<out>/manifest.json` of this batch file."),
      force: z.boolean().default(false).describe("Render chosen rows again although every entry is `done` and its file exists; without it they are skipped."),
      dryRun: z.boolean().default(false).describe("Validate every chosen row × format and return the plan; nothing is rendered or written."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      file: z.string().describe("Absolute path of the batch file."),
      template: z.string().describe("Template timeline id."),
      out: z.string().describe("Absolute output folder."),
      manifest: z.string().nullable().describe("Absolute path of `manifest.json`; null in a dry run."),
      dryRun: z.boolean(),
      preset: z.string().nullable().describe("Preset id every row renders with; null when no row was chosen."),
      quality: QualityTierSchema.extract(["draft", "final"]).nullable().describe("Tier asked for; null = the preset as written, or no row chosen."),
      entries: z
        .array(BatchEntrySchema)
        .describe("Every row × format, row order then format order: the manifest as written now. Rows not rendered by this call keep their earlier entries; `queued` ones are what it renders."),
      skipped: z.array(z.string()).describe("Chosen rows left alone because every entry is `done` and its file exists (pass `force`); empty when none."),
      jobs: z.array(JobSchema).describe("Render jobs queued by this call: the first row's. Later rows queue as the one before ends."),
    }),
  },
  frame: {
    description:
      "Capture the composited frame showing at timeline time `at` as a PNG, JPEG or WebP image, rendered by the export " +
      "compiler (single-frame plan), so it matches `render` and works with the app closed. This is how an image project " +
      "(ADR 0017) is exported: `at: 0`. `projectFormat` captures the frame as that format of the project lays it out " +
      "(ADR 0027), e.g. `9x16`; with `view: proposal` that includes a format only an open review proposal adds (ADR 0036). Size: the preset's when `preset` is given (it must have the format's aspect), else the " +
      "format's (default: the primary, i.e. the project resolution). Fails with InvalidOperation (`at` outside the " +
      "timeline, data.valid has the range; a preset of another aspect), ExportUnsupported, PresetNotFound, " +
      "FormatNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`; the frame whose time span holds it is captured."),
      out: AbsolutePath.describe("Absolute image path to write, e.g. `/tmp/frame.png`; its folder is created."),
      preset: z.string().min(1).optional().describe("Export preset id whose width and height to use. Default: the format's size."),
      projectFormat: FormatIdSchema.optional().describe(
        "Format of the project to capture in (`format.list`), e.g. `9x16`. Default: the primary format. Not the image type: that is `format`.",
      ),
      format: FrameFormatSchema.optional().describe(
        "Image format. Default: from the extension of `out` (`.jpg`/`.jpeg` JPEG, `.webp` WebP), else `png`.",
      ),
      quality: z
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`JPEG and WebP quality, 1 (smallest) to 100 (best). Default ${DEFAULT_FRAME_QUALITY}. PNG is lossless and ignores it.`),
      view: ViewParam,
    }),
    result: z.object({
      ...ViewedShape,
      path: z.string().describe("Absolute image path written."),
      format: FrameFormatSchema.describe("Format written."),
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index captured (0-based, project fps)."),
      at: z.number().describe("Start time of that frame, timeline seconds."),
      clip: z.string().nullable().describe("Clip showing on the first video track; null in a gap (black frame)."),
      projectFormat: z.string().describe("Format of the project the frame was laid out in."),
      width: z.int(),
      height: z.int(),
    }),
  },
  review: {
    description:
      "Look at a film before showing it (#457): write contact sheets and strips of a timeline, or of an exported video " +
      "with `file`, into `.frameshell/review/<n>/` (`<n>` counts runs; the last 10 are kept) and report them. Never " +
      "touches project files. Sheets (`sheets`, default the four below, plus `safe` when it applies and `metrics`): `contact` (6 tiles wide, 10 in a vertical format, 30 per " +
      "image; frames at clip starts and ends, cuts, markers, subtitle cues and the deepest zoom of a clip, plus one every " +
      "`every` seconds, each labelled with its time), `phone` (one frame per second at 360 px wide: how it reads on a " +
      "phone), `motion` (the two fastest moments, found by how much the picture changes between frames, as 12 consecutive " +
      "frames each: pops, overlaps and blank frames only show there) and `seam` (the last 6 and the first 6 frames, to " +
      "judge a loop). `safe` (with `platform`, or the platforms the style guide names on a vertical film): up to 36 frames chosen like the " +
      "contact sheet with the platform's UI zones (`style.show` safeZones, one source in `@frameshell/schema`) shaded red; a frame where the captions of a " +
      "subtitle track cross a zone is marked `!subtitle`, and `safeZones` in the result lists them per track and zone (captions are the only text review " +
      "can measure; a file has none). A timeline is rendered frame by frame like `frame` (draft work: matches `render`, not a full " +
      "render, app closed is fine); a file is decoded with the managed ffmpeg, so footage and any generated clip type " +
      "are covered. Motion of a long timeline is sampled at most 90 times, so its peaks are approximate. `from` and " +
      "`to` limit it to a range (the seam is then the range's ends). `metrics` (default on, or named in `sheets`) writes `metrics.json` and " +
      "returns `metrics`: numbers a sheet cannot tell, measured on grey frames and the sound: the longest still stretch, the largest gap between " +
      "visual events, near-blank frames, whether frame 0 is empty, subtitle cues on screen for less than they take to read (a timeline), the loudness of a " +
      "`file` (integrated LUFS, range, true peak, the phone band 200 Hz to 6 kHz; measured after the encode, so export first: a timeline has none) and `craft` warnings " +
      "(still over 3 s, empty frame 0, a blank picture, a cue too short, a true peak above -1 dBTP, a phone band 6 LU under the mix, over 15 s of silence). " +
      "`metrics.sync` sets the sounds against the picture events they belong to (the generated sounds `sound.place` put on the timeline, or the hits found in a `file`'s sound; whooshes, risers and ticks are left out): " +
      "each sound's offset to the nearest visual event (early over 45 ms, late over 75 ms), how many land within 45 ms, the share near an event next to what the same sounds score moved by fixed offsets (random placement), and the cuts with no sound. " +
      "`metrics.seam` is the grey jump between the last frame and the first (a hard cut reads 40 to 80, under 10 is continuous); with `loop` a duplicate or a jump is a warning. " +
      "With `file` and `preset`, `metrics.delivery` checks the file against the export plan. The `safe` sheet and `safeZones` also flag graphics (generated clips with an alpha render: titles included) and faces (footage with a cached `people scan`) that reach into a zone, " +
      "and each is a `safe-zone` craft warning. " +
      "A project's `requirements.json` (written with `file.write`) is judged on every run with metrics: `metrics.requirements` lists each expectation it states (film length, longest still stretch, a held end card, loudness of a `file`, " +
      "smallest caption size, per clip `appearsBy`, `before` and `keepsMoving`) as pass, fail or skipped, with what was measured. Craft warnings stay warnings (`severity` `warn`) unless the file lists their check in `fail`; " +
      "a `waivers` entry (check, optional clip, reason) lifts the warnings it covers out of `craft` into `metrics.waived` with its reason, never silently. `requirements.failed` counts what still fails. " +
      "The MCP tool returns the sheets as images. " +
      "Fails with InvalidOperation (a range outside the film, a file with no picture), AssetNotFound (`file` missing), " +
      "TimelineNotFound, FormatNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      file: z
        .string()
        .min(1)
        .optional()
        .describe(
          "An exported video to review instead of the timeline (the judge of a reel is the file people get): absolute, or relative to `cwd`, " +
            "e.g. `exports/draft.mp4`. Then `view` is ignored, and `timeline` and `projectFormat` only name the export plan `preset` is checked against; only the grid frames of the contact sheet exist (no cuts, markers or cues).",
        ),
      from: z.number().nonnegative().optional().describe("Start of the range, seconds. Default 0."),
      to: z.number().positive().optional().describe("End of the range, seconds. Default the end of the film."),
      sheets: z
        .array(ReviewOutputSchema)
        .min(1)
        .optional()
        .describe("Outputs to write: the sheets and `metrics`. Default contact, phone, motion, seam and metrics, plus safe when a platform is given or the style guide names platforms on a vertical film."),
      platform: SafeZoneSchema.shape.platform
        .optional()
        .describe(
          "Platform whose UI zones the `safe` sheet draws (instagram-reels, tiktok, youtube-shorts, youtube); adds `safe` to the default sheets. Default: the platforms of the style guide, when `sheets` names `safe` or the film is vertical.",
        ),
      every: z
        .number()
        .positive()
        .optional()
        .describe("Seconds between the grid frames of the contact sheet. Default 0.5 (2 per second), widened so that a long film stays within 120 tiles."),
      projectFormat: FormatIdSchema.optional().describe("Format of the project to lay a timeline out in (`format.list`), e.g. `9x16`. Default: the primary format."),
      preset: z
        .string()
        .min(1)
        .optional()
        .describe(
          "With `file`: the export preset the file was made with (`export.presets`), e.g. `youtube-1080p`. The file is then checked against the export plan of `timeline` (in `projectFormat`) made with it: " +
            "width, height, frame rate, length, video and audio codec and loudness; the answer is `metrics.delivery`.",
        ),
      loop: z
        .boolean()
        .optional()
        .describe("The film is meant to repeat (a title loop, a GIF): a last frame that repeats the first, or jumps from it, becomes a craft warning (`metrics.seam` is measured either way)."),
      view: ViewParam,
    }),
    result: ReviewResultSchema,
  },
  analyze: {
    description:
      "Measure a reference video (#471): what it does, in numbers, so \"make it like this\" works from facts instead of a guess. " +
      "Take its grammar (rhythm, colour, look, events, loudness, tempo), never its content. Writes `.frameshell/analysis/<name>/` " +
      "(replaced by a new run with the same name; regenerable, project files are never touched) and returns: the **shot table** " +
      "(cuts found by ffmpeg's scene score on every frame, each shot's start, end and length, the score of the cut that opens it, a JPEG of " +
      "its middle frame and its dominant colours), the **cutting** (shot count, cuts per minute, average, median, shortest and longest shot), " +
      "the **palette** of the whole film, the **look** (brightness 0 to 1, contrast, saturation, warmth from -1 blue to 1 red, and an 8 x 6 grid of mean colours for the film in the result and for every shot in `analysis.json`), " +
      "the **rhythm** (`shotLengthCv`: spread of the shot lengths over their mean, 0 a metronome; `stillShare`: share of frames in which the picture does not change; `longestStill`; big changes of the picture, their count and per minute; the `largestGap` between them; `bursts`: 3 or more big changes within 1.5 s), " +
      "the **events** in time order (`flash`: the picture jumps brighter or darker for at most 0.25 s; `appear` / `disappear`: part of the picture gains or loses detail while the rest holds, with its `region` as fractions of the frame, which is where a caption or an element shows up; `hold`: the picture does not change for 0.5 s or more; `hit`: a sudden rise of the sound with its `offset` in seconds to a big change of the picture within 0.2 s, null when none is near), " +
      "the **curve** (the change of the picture over time, one value per 0.1 s or more, and its `moves`: steady stretches with their start, duration, peak and the closest ease: linear, in, out or inOut), " +
      "the **ink** of each shot and of the film (share of the picture covered by graphics or text, its peak, when and the box of grid cells), " +
      "the **sync** (seconds the mouth of a talking face moves after the voice, when this exact file has a cached face scan from `people.scan`; otherwise `reason` says why it was skipped), " +
      "`labels` (MEASURED, ESTIMATED or DECISION for every value, by field path), " +
      "the **loudness** by EBU R128 (integrated LUFS, range LU, true peak dBTP), the **tempo** and " +
      "beats when the sound has a steady beat (the beat detector of `beats.measure`; its beat lists are in `analysis.json`, not in this " +
      "result; `low: true` means do not trust it: speech and ambient sound read as low), and sheets to look at: the **contact** sheet " +
      "(a frame every half second, 2 per second, plus the first frame of every shot, 360 tiles at most) and the **shots** sheet (the middle frame " +
      "of every shot). Every time is a frame index ÷ fps rounded down to the millisecond, and `startFrame`/`endFrame` give the frames. " +
      "A hard cut is found; a dissolve, a whip pan or a jump cut inside one continuous take is not (lower `threshold` to catch softer ones; " +
      "a read of the text itself is not made; events, ink and ease are hints, so look at the frames they name). Label what you tell the person as `labels` does: " +
      "MEASURED, ESTIMATED (hints, and what you read off the sheets by eye: say which frames to check) or DECISION (our creative choice). To compare our film with it, use `analyze.diff`. " +
      "Runs as a background job of kind `analyze` (`job.list`); a 1-minute 1080p video takes about 35 seconds. The MCP tool returns the " +
      "sheets as images. Example: `{ file: \"references/reel.mp4\" }`. Fails with AssetNotFound (`file` missing), " +
      "InvalidOperation (no picture, or shorter than a frame), the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("The video to analyse: absolute, or relative to `cwd`. It may be anywhere (a download, a reference folder); it is only read."),
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit")
        .optional()
        .describe("Name of the analysis, its folder is `.frameshell/analysis/<name>/`. Default: the file name in lower case, e.g. `reel` for `Reel.mp4`. A new run with the same name replaces the folder."),
      threshold: z
        .number()
        .min(0.05)
        .max(0.95)
        .optional()
        .describe("Scene score (how different a frame is from the one before, 0 to 1) from which a frame opens a new shot. Default 0.3: hard cuts. Lower finds softer ones and false ones (flashes, fast motion); higher keeps only violent changes."),
    }),
    result: AnalyzeResultSchema,
  },
  "analyze.diff": {
    description:
      "Compare our film with a reference video (#471): how far apart they are, in numbers, instead of \"looks similar\". The two are lined up by " +
      "**activity-curve alignment** (how much the picture changes over time, correlated within `maxLag` seconds either way, or the `lag` you give), then read at matched times: " +
      "`alignment` (`lag`: seconds to add to a time of our film to find the same moment of the reference; `source`: `activity`, `forced` or `none`; `correlation` of the two curves), " +
      "`energy` (mean and 95th-percentile motion of each, their `ratio` (above 1 our film moves more), and `windows`: both curves second by second, to see where one moves and the other holds), " +
      "`diff` (SSIM, ffmpeg's structural similarity, of our frame and the reference's every `every` seconds: `samples`, `mean`, the lowest `min` and its time, and `below`: the share of readings under 0.5) " +
      "and a **side-by-side sheet** (our frame left, the reference's right at the same matched time, the lowest-SSIM moments and evenly spread ones, `snapshots` pairs; the MCP tool returns it as an image). " +
      "Read it as a distance, not a pass or fail: a different film in the same style scores low SSIM everywhere and can still match in energy. A reference of another shape is stretched to our film's (a warning says so). " +
      "Writes `.frameshell/analysis/<name>/` (`diff.json` and the sheet; replaced by a new run of the same name; project files are never touched). `labels` marks every value MEASURED, ESTIMATED or DECISION. " +
      "Runs as a background job of kind `analyze` (`job.list`); a 30-second pair of 720p films takes about 10 seconds. Example: `{ file: \"exports/reel.mp4\", reference: \"references/reel.mp4\" }`. " +
      "Fails with AssetNotFound (a file missing), InvalidOperation (no picture, or no stretch the two share at that lag), the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("Our film: an export, or any video. Absolute, or relative to `cwd`."),
      reference: z.string().min(1).describe("The reference video to compare it with: absolute, or relative to `cwd`; it may be anywhere, it is only read."),
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit")
        .optional()
        .describe("Name of the comparison, its folder is `.frameshell/analysis/<name>/`. Default `<film>-vs-<reference>` (file names in lower case, 64 characters at most). A new run with the same name replaces the folder, so do not reuse the name of an `analyze` run you want to keep."),
      lag: z.number().min(-3600).max(3600).optional().describe("Seconds to add to a time of our film to find the same moment of the reference (positive: the reference is later), instead of finding it. Use it when you know where the two start together; the alignment is then a DECISION."),
      maxLag: z.number().min(0.5).max(30).optional().describe("Most seconds the alignment looks for the lag either way. Default 3."),
      every: z.number().min(0.1).max(30).optional().describe("Seconds between SSIM readings. Default 0.5; a long film is read less often (600 readings at most)."),
      snapshots: z.int().min(1).max(24).optional().describe("Pairs of frames on the side-by-side sheet. Default 8, at most 24 (12 pairs make one image)."),
    }),
    result: AnalyzeDiffResultSchema,
  },
  cover: {
    description:
      "Write a cover image: a frame of the timeline with one big word over it, rendered by the export compiler (as `frame` " +
      "and `render` do), checked readable at thumbnail size (180 px wide: the capitals must stay 12 px tall or more). With " +
      "`text` and no `at` the frame is where that word is first spoken; with neither, the first whole picture (after a fade in). The word is " +
      "upper-case in the subtitle face, centered, outlined, as large as the width allows; no subtitles are drawn on a " +
      "cover. Size: the preset's when `preset` is given, else the project resolution. `readability.readable` false " +
      "means the word is too long to read in a grid: shorten it. The same frame can open the exported video: " +
      "`render` with `cover`. Fails with InvalidOperation (`at` outside the timeline, text with nothing to draw), " +
      "ExportUnsupported, PresetNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      ...CoverChoiceShape,
      out: AbsolutePath.optional().describe(
        "Absolute image path to write, e.g. `/home/ana/videos/launch/exports/cover.png`; its folder is created. " +
          "Default `<project>/exports/<timeline>-cover.png`.",
      ),
      preset: z.string().min(1).optional().describe("Export preset id whose width and height to use. Default: project resolution."),
      format: FrameFormatSchema.optional().describe("Image format. Default: from the extension of `out`, else `png`."),
      quality: z
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`JPEG and WebP quality, 1 (smallest) to 100 (best). Default ${DEFAULT_FRAME_QUALITY}. PNG is lossless and ignores it.`),
      view: ViewParam,
    }),
    result: z.object({
      ...ViewedShape,
      path: z.string().describe("Absolute image path written."),
      format: FrameFormatSchema.describe("Format written."),
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index used (0-based, project fps)."),
      at: z.number().describe("Start time of that frame, timeline seconds."),
      source: z
        .enum(["at", "word", "default"])
        .describe("How the frame was chosen: `at` given, `word` where `text` is first spoken, `default` the first picture."),
      text: z.string().nullable().describe("The word as drawn (upper-case); null when the cover has none."),
      readability: z
        .object({
          thumbnailWidth: z.int().describe("Width the cover is judged at, px."),
          capHeight: z.number().describe("Height of a capital letter at that width, px."),
          minCapHeight: z.number().describe("Smallest capital height that reads, px."),
          readable: z.boolean(),
        })
        .nullable()
        .describe("Thumbnail check of the word; null when the cover has no word."),
      width: z.int(),
      height: z.int(),
      warnings: z.array(z.string()).describe("Things to fix: the word is not spoken anywhere, or too small to read in a grid; empty when none."),
    }),
  },
  "inspect.point": {
    description:
      "What a point of the frame shows at timeline time `at` (ADR 0011): every clip whose picture covers it, topmost " +
      "first, the clip seen there, and in a generated clip (`hyperframes`, `remotion`) the DOM element painting that " +
      "pixel with its selector, text, box, computed styles, HTML and ancestors, as the user's Pick tool reports it. Use it " +
      "to find what to edit (\"the box at the top right at 12 s\") or to check an edit landed. Works with the app closed: " +
      "generated clips are loaded in headless Chrome (a second or two each). Elements need a trusted project with the " +
      "clip's plugin; otherwise `unavailable` says why and only the clips are reported. Footage counts as painting its " +
      "whole box (alpha of footage is not read). With `segment` on a photo in an image project it also names the part of the " +
      "photo under the point as three masks (ADR 0022). Fails with InvalidOperation (`at` or the point outside the timeline or " +
      "frame), TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`; the frame whose time span holds it."),
      x: z.number().nonnegative().describe("Horizontal position, 0 = left edge: a fraction of the frame width (e.g. `0.71`), or project pixels with `unit: \"pixel\"`."),
      y: z.number().nonnegative().describe("Vertical position, 0 = top edge: a fraction of the frame height (e.g. `0.14`), or project pixels with `unit: \"pixel\"`."),
      unit: z.enum(["fraction", "pixel"]).default("fraction").describe("What `x` and `y` are. Default `fraction`."),
      segment: z
        .boolean()
        .default(false)
        .describe(
          "In an image project, when the clip seen is a still photo: also segment the part of the photo under the point (ADR 0022). Writes three " +
            "mask PNGs under `.frameshell/context/` and returns them as `segment` (smallest first, `chosen` = best score). The first use downloads " +
            "the model (about 45 MB) and takes seconds; later points on a photo take about 0.2 s. Elsewhere `segmentUnavailable` says why. Default false.",
        ),
      view: ViewParam,
    }),
    result: InspectedPointSchema.extend({
      ...ViewedShape,
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index (0-based, project fps)."),
      pixel: z.object({ x: z.int(), y: z.int() }).describe("The point in project pixels."),
    }),
  },
  "asset.import": {
    mutating: true,
    description:
      "Bring media files into the enclosing project's `assets/` and queue their ingest (probe, CFR proxy, PCM sidecar, " +
      "waveform, thumbnails). Returns at once; follow progress with `job.list`, `status`, or the `job.progress` and " +
      "`asset.changed` events (`events.subscribe`). Files already under " +
      "`assets/` are not copied. A name clash with different content gets a `-2`, `-3`… suffix. Unchanged content " +
      "reuses cached outputs (job `cached: true`). Material from an outside source (a stock site, a sound library, a font) " +
      "needs its provenance: pass `sourceUrl`, `licence`, `author` (and `title`) and each file is recorded in `credits.json` with its " +
      "content hash (ADR 0026); `credits.check` fails on placed assets without it. Give one source per call. Fails with ProjectNotFound, or AssetNotFound when a source is not a file.",
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
      ...ProvenanceParams,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      imported: z.array(
        z.object({
          source: z.string().describe("Absolute path given."),
          asset: z.string().describe("Project-relative asset path, e.g. `assets/raw-01.mp4`."),
          copied: z.boolean().describe("False when the file already was in `assets/` (as-is or with identical content)."),
          job: JobSchema,
          provenance: z.boolean().describe("True when an entry for the file was written to `credits.json` (provenance params were given)."),
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
  "credits.set": {
    mutating: true,
    description:
      "Record where an asset already in `assets/` came from (ADR 0026): source URL, licence, author, title, an optional credit line. " +
      "Written to `credits.json` with the file's current content hash. Fields given replace the entry's; fields left out keep their value " +
      "while the content is unchanged, and start over when the file changed. Use it for files that were not imported with provenance, and " +
      "`licence: \"own\"` for the person's own footage. Example: `{ asset: \"assets/rain.ogg\", licence: \"CC-BY-4.0\", author: \"Ana Pérez\", " +
      "sourceUrl: \"https://openverse.org/audio/9f2c\" }`. Fails with AssetNotFound (no such file under `assets/`), InvalidOperation " +
      "(`asset` outside `assets/`), InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Asset path: project-relative (`assets/rain.ogg`), absolute, or relative to `cwd`."),
      ...ProvenanceParams,
    }),
    result: z.object({ dir: z.string().describe("Project root."), entry: CreditEntrySchema }),
  },
  "credits.check": {
    description:
      "Judge the provenance of every asset the project's timelines place (clips, multicam angles and mics) against `credits.json`, " +
      "and build the credit text for the video description. `ok` is false when any placed asset has no entry, no licence, a licence that " +
      "needs credit without an author or credit line, content that changed since it was recorded, or is missing: unverified never passes. " +
      "CC0, public domain and `own` need no credit. Run it before export and publishing; fix each `problem` with `credits.set` or by " +
      "re-importing with provenance, or remove the asset. The CLI exits 1 when `ok` is false. Fails with InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      ok: z.boolean().describe("True when every placed asset is `ok`."),
      assets: z.array(CreditAssetSchema).describe("Every placed asset, sorted by path."),
      credits: z.array(z.string()).describe("Credit lines of the placed assets that need one, without duplicates, sorted."),
      text: z.string().describe("`credits` as the block to paste into the video description; empty when none is needed."),
    }),
  },
  "brand.capture": {
    mutating: true,
    description:
      "Capture a brand from a public web page (ADR 0044): open `url` in Frameshell's headless Chrome at 1600x1000 (2x), wait for the " +
      "network to settle, scroll to load lazy content, then save into the project: logo candidates from the header and nav (inline SVG " +
      "sanitised, or the image file), favicons and touch icons, the share image (og:image), the first screen (`hero.png`) and the whole page " +
      "at 1x (`page.png`, up to 16384 px tall), all under `assets/brand/<id>/` (`<id>` from the host: `example-com`, `-2` when taken); and " +
      "font faces into `assets/fonts/` only when the font file's own name table names OFL-1.1, Apache-2.0 or UFL (otherwise the family, " +
      "weights and why are listed). It measures colours by use and role with an accent (the colour in the most roles), fonts by use, " +
      "`:root` variables, headings and buttons, and records video URLs without downloading them. Everything goes into `brand.json` at " +
      "the project root, and each saved file gets a `credits.json` entry with its source URL and no licence (fonts: the licence they " +
      "name), so `credits check` fails on them until the person confirms they may use them (`credits set --licence own` for their own " +
      "brand). It never changes `style.json`: `style` lists suggested `style set` calls; show the person what was found first. " +
      "Only `http`/`https` URLs on ports 80 and 443; the page reaches public addresses only (private, loopback and link-local " +
      "addresses, including through redirects, are refused), no cookies or sign-in. At most 120 s and 150 MB. Runs as a background " +
      "job of kind `brand`. `capture.ok` is false (`reason: little-text`) when the page yielded very little text and no logo, icon, " +
      "share image or font: a login wall or an empty app shell; look at `hero.png`. Example: `{ url: \"https://example.com\" }`. " +
      "Fails with InvalidOperation (`reason`: `url`, `scheme`, `credentials`, `port`, `address` (not a public address, or a redirect to " +
      "one), `load`, `timeout`), InvalidProjectFile (`brand.json` is broken), ProjectNotFound, or the Binary* errors when headless " +
      "Chrome cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      url: z.string().min(1).max(MAX_SOURCE_URL).describe("Public page to capture, `http` or `https`, at most 2048 characters, e.g. `https://example.com/pricing`."),
    }),
    result: BrandCaptureResultSchema,
  },
  gc: {
    mutating: true,
    description:
      "Delete regenerable files under `.frameshell/` that nothing uses any more: proxies, PCM sidecars, waveforms, " +
      "thumbnails, energy envelopes, transcription WAVs, voice prints and subject mattes of assets deleted or changed since (or built for an older " +
      "recipe or another fps), clip renders no timeline's generated clip keys, baked audio effects no clip plays, and temp files of interrupted jobs. " +
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
      "subscribing to `job.progress` and follow the events instead. A `queued` job says its `position` (1 = next) and its " +
      "`priority`: generated-clip renders (`clip` jobs) run one at a time, interactive ones (what the preview, a frame, an " +
      "export or `clip.renders` asks for) before background ones, and a background one still starts after a few " +
      "interactive ones, so a long render never waits forever.",
    params: z.strictObject({
      cwd: CwdParam,
      active: z.boolean().default(false).describe("Only `queued` and `running` jobs. Default false: also finished ones."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      jobs: z.array(JobSchema).describe("Oldest first."),
    }),
  },
  "job.cancel": {
    mutating: true,
    description:
      "Cancel a generated-clip render (a `clip` job from `job.list`): a queued one is dropped at once and the next one starts, " +
      "a running one is stopped and ends `canceled` (follow `job.progress`, or `job.list`). The clip is then `failed` in " +
      "`clip.renders` with the cancel as its error, and the daemon does not render it again until its inputs change; an " +
      "export or `render` that needs it renders it again. Other kinds of job cannot be canceled (an `ingest` would be " +
      "queued again when the project reopens). Fails with InvalidOperation (data `{ op, reason, field: \"job\" }`; " +
      "`reason`: `unknown-job`, no job of this project has that id (finished ones are dropped after a while), or `not-cancelable`, " +
      "not a `clip` job). Canceling a finished job changes nothing. Example: `{ job: \"j_c7\" }`.",
    params: z.strictObject({
      cwd: CwdParam,
      job: z.string().min(1).describe("Job id from `job.list` or `clip.renders`, e.g. `j_c7`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      job: JobSchema.describe("The job after the request; `state` is `canceled` for a queued one, still `running` for a running one until it stops."),
    }),
  },
  "clip.renders": {
    description:
      "Render cache state of every generated clip (adapter clips such as `hyperframes`) on a timeline (SPEC §6.5). The " +
      "daemon renders these clips in the background whenever one is added, its props change, or a file its composition " +
      "uses changes; unchanged clips reuse the cache. Use it after `clip.add` of a generated clip to learn when its " +
      "render is ready (`state: \"ready\"`), or follow `job.progress` events of kind `clip`. `render` waits for " +
      "pending clip renders itself. A `failed` clip carries the adapter's `error`: fix the composition, then check " +
      "again. Background renders cover only the primary format; `format` reports the renders at another format's " +
      "size and queues the missing ones (`render --formats` and `frame` in that format make them too). Fails with " +
      "TimelineNotFound, FormatNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      format: FormatIdSchema.optional().describe("Format of the project (`format.list`), e.g. `9x16`. Default: the primary format."),
    }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Timeline revision the states refer to."),
      clips: z
        .array(ClipRenderSchema)
        .describe("Generated clips on video tracks, with those of nested timelines where they play (as export flattens them), in track then time order."),
    }),
  },
  "clip.verify": {
    description:
      "Check that a generated clip's picture is a pure function of time (ADR 0033), as a motion clip must be: its live page is " +
      "loaded in headless Chrome at the project resolution and `probes` frames are captured at `(i + 0.37) * duration / probes` " +
      "of the clip's played part, each twice. Cold: a fresh page seeks straight to the time. Reseek: one page shows an unrelated " +
      "probe first, then the time. The two captures of a probe must not differ by more than `tolerance` per channel " +
      "(red, green, blue, alpha; default 2 of 255); a bigger difference means the composition keeps state between frames " +
      "(a CSS transition, a timer, a clock, unseeded randomness, a composited layer) and its render would depend on the order " +
      "frames are painted. `ok` is false then, and `worst` names the probe time, the pixel and the page element that paints it. " +
      "`distinct` counts different cold pictures: 1 with several probes (a `warnings` entry says so) means the clip never moves, " +
      "for example a composition whose timeline is not bound to the seek. Reads only: never renders, writes no file. Takes " +
      "seconds to a minute (a page load per probe). Needs the plugin of the clip's type loaded and trusted, and its adapter to " +
      "have a live preview (`hyperframes` does). Example: `{ timeline: \"main\", clip: \"c_1a2b3c\" }`. Fails with ClipNotFound, " +
      "TimelineNotFound, LiveUnavailable (no adapter, no live preview, or the page does not define `window.frameshellLive`), " +
      "OutsideProject, or the Binary* errors when headless Chrome or ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Generated clip id as `clip.renders` reports it (`<nested clip>/<clip>` inside a nested timeline)."),
      probes: z
        .int()
        .min(2)
        .max(VERIFY_MAX_PROBES)
        .default(VERIFY_DEFAULT_PROBES)
        .describe(`Frames to capture, evenly spread over the clip. Default ${VERIFY_DEFAULT_PROBES}.`),
      tolerance: z
        .int()
        .min(0)
        .max(255)
        .default(VERIFY_DEFAULT_TOLERANCE)
        .describe(`Largest per-channel difference (of 255) that still counts as the same picture. Default ${VERIFY_DEFAULT_TOLERANCE}.`),
    }),
    result: ClipVerifyResultSchema,
  },
  "audio.bakes": {
    // The app's preview only: export bakes what it needs itself, so an agent never has to wait on this.
    internal: true,
    description:
      "Baked sound (ADR 0031) of every media clip with audio effects on a timeline, nested timelines flattened: one entry per asset and " +
      "chain. Bakes neither ready nor failed are queued as background `audio-fx` jobs; the preview plays the dry sidecar until `ready`. " +
      "Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Revision of the timeline read (the proposal's with `view: proposal`)."),
      bakes: z.array(AudioBakeSchema).describe("In track then time order of their first clip."),
    }),
  },
  "matte.status": {
    // The app's preview only: export and frame captures make the mattes they need themselves (`matte.prepare` for agents).
    internal: true,
    description:
      "Subject matte (ADR 0032) of every video asset a subject layer of a timeline plays (the plates of tracks `behind` one, nested " +
      "timelines flattened). Mattes neither ready nor failed are queued as background `matte` jobs; the preview draws the plate " +
      "without its subject until `ready`. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Revision of the timeline read (the proposal's with `view: proposal`)."),
      mattes: z.array(MatteStateSchema).describe("One per asset, in track then time order of its first subject clip."),
    }),
  },
  "clip.live": {
    // The app's preview only: a page to load in an iframe is of no use to an agent, so no MCP tool or CLI command.
    internal: true,
    description:
      "Live page of one generated clip (ADR 0010), which the app's preview plays while the clip's render is not ready. " +
      "`clip` is an id as `clip.renders` reports it (`<nested clip>/<clip>` inside a nested timeline). Never writes project " +
      "files. Fails with LiveUnavailable (no adapter, adapter without live preview, or the adapter failed), ClipNotFound, " +
      "TimelineNotFound, OutsideProject (the adapter's page escapes the project).",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, clip: z.string().min(1).describe("Clip id as `clip.renders` reports it.") }),
    result: z.object({
      clip: z.string(),
      root: z.string().describe("Project-relative, `/`-separated directory the page may load files from."),
      entry: z.string().describe("Project-relative, `/`-separated HTML file inside `root`."),
      head: z.string().describe("Script to insert at the start of the entry's `<head>`; defines `window.frameshellLive`."),
      key: z.string().describe("The clip's render cache key now: when `clip.renders` reports another, ask again."),
      elementCss: z
        .string()
        .optional()
        .describe("Sheet of the clip's `elements` (ADR 0021), which the page's bridge applies; absent when the clip has none."),
      styleCss: z
        .string()
        .optional()
        .describe(
          "The project style's token sheet (ADR 0028), inserted first in the page's `<head>` as the render gets it; absent " +
            "without `style.json` or when the clip's adapter does not apply style tokens.",
        ),
    }),
  },
  "context.write": {
    // The app's Chat about this only: it may not write under `.frameshell/` itself (the daemon is the only writer).
    internal: true,
    description:
      "Write one Chat about this details file (ADR 0011) into `.frameshell/context/`: what a pick or a preview region points at " +
      "(layers, element facts), for the agent to read from the reference line. Regenerable and gitignored; `gc` deletes " +
      "files older than 7 days. Replaces a file of the same name. Fails with OutsideProject when `.frameshell/context` leaves the project.",
    params: z.strictObject({
      cwd: CwdParam,
      name: z
        .string()
        .regex(/^e_\d+_\d+\.json$/)
        .describe("File name `e_<frame>_<n>.json`: program frame of the pick, its place in the selection (1-based)."),
      content: z.string().max(1_000_000).describe("JSON text to write."),
    }),
    result: z.object({ path: z.string().describe("Project-relative path written, e.g. `.frameshell/context/e_0421_1.json`.") }),
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
        .describe(
          "Model id: one the provider ships (`large-v3-turbo-q5_0`) or one registered on this machine with `model.add`. " +
            "Default: `transcription.model`, else this machine's default (`model.default`), else the provider's default. " +
            "An id that is neither fails with ModelNotRegistered.",
        ),
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
      modelHash: z
        .string()
        .nullable()
        .describe("`sha256:<hex>` of the registered model file used (`model.add`), also written to the transcript; null for the provider's own models."),
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
      warnings: z
        .array(z.string())
        .describe(
          "What makes this transcript less reliable, e.g. a registered model file that changed since `model.add`, or " +
            "word timing without alignment data for a custom whisper.cpp model.",
        ),
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
        .describe(
          "Model id. Default: `transcription.model`, else the model of the source transcripts, else this machine's default " +
            "(`model.default`), else the provider's default.",
        ),
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
  "transcribe.speakers": {
    description:
      "Find who says each word of an asset's transcript (ADR 0016, speaker diarization; local, CPU): writes `speaker` (`s1`, `s2`, ...) " +
      "on the words of `transcripts/<asset>.words.json` and `speakers: [{ id, name }]` (default names `Speaker 1`, ...). For a recording " +
      "where several people share one mic or one mixed track; with one mic per person `multicam.turns` already knows who speaks. " +
      "Run `transcribe` first. Re-running keeps each voice's id and name where it matches the last run, and human corrections in " +
      "`edits` (`{ \"w_000042\": { \"speaker\": \"s2\" } }`) always win; rename a speaker by editing its `name` in the file. " +
      "Pass `speakers` when you know how many people talk: it is more reliable than letting the voices decide. The first run " +
      "downloads sherpa-onnx, two models and ONNX Runtime Web (about 95 MB; less when people or face tools installed some). Example: `{ asset: \"assets/podcast.mp4\", speakers: 2 }`. Fails with " +
      "InvalidOperation (no transcript, or a stale one: re-run `transcribe`), AssetNotFound, OutsideProject, InvalidProjectFile, " +
      "TranscriptionFailed, or the Binary* errors.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Asset file, absolute or relative to `cwd`; its transcript must exist and be current."),
      speakers: z.int().min(1).max(32).optional().describe("Number of people speaking, when known. Default: found from the voices."),
    }),
    result: z.object({
      transcript: z.string().describe("Updated transcript file, project-relative."),
      asset: z.string().describe("Project-relative asset path."),
      speakers: z
        .array(
          z.object({
            id: z.string().describe("Speaker id on the words, e.g. `s1`."),
            name: z.string(),
            words: z.int().describe("Words this speaker says, corrections included."),
            seconds: z.number().describe("Sum of those words' spans, source seconds."),
          }),
        )
        .describe("In order of first appearance."),
      segments: z.int().describe("Speech segments diarization found."),
      unassigned: z.int().describe("Words no speech segment covers: they have no speaker."),
      corrections: z.int().describe("Human speaker corrections in `edits`, kept and applied."),
      seconds: z.number().describe("Wall time of the whole call."),
    }),
  },
  "model.list": {
    description:
      "List transcription models: model files registered on this machine (`model.add`) with their state, this " +
        "machine's default model per provider, and, with `cwd`, the project's providers with the models they ship " +
        "(size, downloaded) and the model a `transcribe` there would use. A project names only a model id " +
        "(`transcription.model`); the file behind a registered id is per machine.",
    params: z.strictObject({
      cwd: CwdParam.optional().describe("Directory inside a project, to list its providers and transcription settings."),
    }),
    result: ModelListResultSchema,
  },
  "model.add": {
    mutating: true,
    description:
      "Register a local model file under `id` on this machine, for `transcribe --model <id>` or `transcription.model`. " +
        "Only formats that cannot run code: whisper.cpp ggml, gguf, ONNX; pickle-based files (`.nemo`, `.pt`, " +
        "`.ckpt`) fail with UnsupportedModelFormat. The file is not verified: registering it is the user's consent. " +
        "Its SHA-256 is stored (hashing a large file takes seconds; progress arrives as notifications) and written " +
        "into each transcript made with it. Registering an id again replaces it. The file stays where it is. Only " +
        "register a file the user named.",
    params: z.strictObject({
      id: ModelIdSchema,
      file: AbsolutePath.describe("Absolute path of the model file, e.g. `/home/ana/models/ggml-es-small.bin`."),
      options: z
        .record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.string().min(1))
        .default({})
        .describe(
          "Provider settings kept with it. whisper.cpp: `dtw`, the alignment-heads preset of the model it was trained " +
            "from (`tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large.v1`, " +
            "`large.v2`, `large.v3`, `large.v3.turbo`); without it word onsets come from token times (less precise).",
        ),
    }),
    result: z.object({
      model: RegisteredModelSchema,
      replaced: z.boolean().describe("True when `id` was registered before, to another file or the same one."),
    }),
  },
  "model.remove": {
    mutating: true,
    description:
      "Forget model `id` on this machine. The file is not deleted. Defaults naming it are cleared. Projects naming it " +
        "fail to transcribe with ModelNotRegistered until it is registered again. Fails with ModelNotRegistered.",
    params: z.strictObject({ id: ModelIdSchema }),
    result: z.object({
      removed: RegisteredModelSchema,
      defaults: z.array(z.string()).describe("Providers whose machine default was this model, now cleared."),
    }),
  },
  "model.default": {
    mutating: true,
    description:
      "Set or clear this machine's default model for a provider: what `transcribe` uses in projects that set no " +
        "`transcription.model`. The id is checked when it is registered or the project at `cwd` lists it.",
    params: z.strictObject({
      provider: z.string().min(1).default("whisper-cpp").describe("Provider id. Default `whisper-cpp`."),
      model: z.string().min(1).nullable().describe("Model id; null clears the default (the provider's own then)."),
      cwd: CwdParam.optional().describe("Directory inside a project whose provider lists the models it ships, to check a model id that is not registered."),
    }),
    result: z.object({
      provider: z.string(),
      model: z.string().nullable(),
      previous: z.string().nullable().describe("Default before; null when none."),
    }),
  },
  "transcription.set": {
    mutating: true,
    description:
      "Set the project's transcription model (and provider) in `frameshell.json` `transcription`, keeping every other " +
        "key. A null `model` removes `transcription.model`: this machine's default, else the provider's, is used. " +
        "The model id is checked like `model.default`. Fails with ProjectNotFound, ModelNotRegistered.",
    params: z.strictObject({
      cwd: CwdParam,
      provider: z.string().min(1).optional().describe("Provider id. Default: the project's, else `whisper-cpp`."),
      model: z.string().min(1).nullable().describe("Model id, or null for the default."),
    }),
    result: z.object({
      provider: z.string(),
      model: z.string().nullable(),
      previous: z.string().nullable().describe("`transcription.model` before; null when unset."),
    }),
  },
  "file.write": {
    mutating: true,
    description:
      "Write a UTF-8 text file inside a Frameshell project (scripts, compositions, config), replacing it atomically. " +
      "Missing parent directories are created. `frameshell.json`, `timelines/*.json`, `transcripts/**/*.words.json`, `beats/**/*.beats.json`, `people.json`, `style.json` and `brand.json` must pass schema validation " +
      "or the write is rejected with InvalidProjectFile and the old file kept. A timeline write is a direct edit (SPEC §6.4): it must " +
      "carry the timeline's current `revision` (else StaleRevision), is checked against timeline rules like any operation, and is " +
      "journaled as a `timeline.patch` operation by author `file` with the revision bumped. In review mode (ADR 0019) a " +
      "timeline write by anyone but the app joins a proposal instead; a new timeline file, or one replacing an unreadable " +
      "file, is kept with the proposal, not in `timelines/`, until the person accepts it. A `frameshell.json` write that " +
      "changes `formats` is journaled as a `file.write` config operation (ADR 0036) in the writer's transaction, so `history` " +
      "lists it and `revert` undoes it; in review mode its formats change waits in the proposal while its other keys are " +
      "written at once. A `style.json` write that changes a value is a `file.write` config operation the same way, and in " +
      "review mode it waits in the proposal whole (prefer `style.set`). Fails with OutsideProject for paths in no project, under daemon-owned `.frameshell/` (any letter case), " +
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
  "file.uses": {
    // The app's Move to Trash only: it lists what would go missing before asking the person.
    internal: true,
    description:
      "What in the enclosing project's timelines names a file or folder: media, timeline and generated clips by " +
      "`asset` or `source`, multicam angles and mics by `asset`. A folder matches everything under it. Read-only.",
    params: z.strictObject({
      path: AbsolutePath.describe("Absolute file or folder path inside a project."),
    }),
    result: z.object({
      project: z.string().describe("Absolute root of the project holding the path."),
      path: z.string().describe("The path, project-relative and `/`-separated."),
      uses: z
        .array(
          z.object({
            timeline: z.string().describe("Timeline id."),
            id: z.string().describe("Clip id, or multicam group id for an angle or mic."),
            ref: z.string().describe("The project-relative path it names."),
          }),
        )
        .describe("Sorted by timeline, then id; empty when nothing names it."),
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
  "target.register": {
    description:
      "Register this connection as an agent target of the enclosing project (ADR 0025) until it closes or " +
      "`target.unregister`: the app's \"Chat about this\" can then send it references, read with `inbox.take` or " +
      "`inbox.wait`. Every connection of one client on one project is one target with one inbox. Sent by `frameshell mcp` " +
      "on MCP `initialize` and by `frameshell ask --wait`. Registering again (another client) moves the registration.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      client: AgentClientSchema,
      title: z.string().min(1).max(200).optional().describe("Display name, e.g. MCP `clientInfo.title` (`Claude Code`)."),
      kind: AgentTargetKindSchema,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      target: AgentTargetSchema,
    }),
  },
  "target.unregister": {
    description: "This connection stops being an agent target of the enclosing project. Not registered: nothing happens.",
    internal: true,
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({ dir: z.string().describe("Project root.") }),
  },
  "target.list": {
    description: "Agent targets of the enclosing project (ADR 0025): who \"Chat about this\" can reach outside the app's terminals.",
    internal: true,
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      targets: z.array(AgentTargetSchema).describe("Sorted by id."),
    }),
  },
  "inbox.put": {
    description:
      "Queue a reference for agent target `target` of the enclosing project; it waits, in memory only, until the target " +
      "reads it. Sent by the app's \"Chat about this\". Fails with InvalidParams naming the targets when `target` is unknown.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).describe("Target id, e.g. `claude`."),
      lines: z.array(z.string()).min(1).describe("The reference's lines."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      target: AgentTargetSchema.describe("The target after queueing."),
      read: z.boolean().describe("A reader waiting with `inbox.wait` took it at once: nothing was queued."),
    }),
  },
  "inbox.take": {
    description:
      "Take the references the person sent you from the Frameshell app (right-click \"Chat about this\" or Cmd/Ctrl+L on " +
      "clips, words, a range, a frame region, files…): each is `[frameshell] …` lines naming what they point at, then " +
      "maybe their request. Call it when the person says \"this\", \"here\", \"what I sent\" or \"what I selected\" " +
      "and no `[frameshell]` line is in their message, then resolve the lines before acting. Taking removes them; " +
      "`references` is empty when nothing waits. Reads this client's inbox; `target` reads another one.",
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).optional().describe("Target id to read, e.g. `claude`. Default: the caller's own."),
    }),
    result: InboxTakeResultSchema,
  },
  "inbox.wait": {
    description:
      "Wait for the person to point at something in the Frameshell app, then take it as `inbox.take` does: when " +
      "nothing waits, block until the person sends a reference or `timeout` seconds pass " +
      `(default ${INBOX_WAIT_DEFAULT_S}, max ${INBOX_WAIT_MAX_S}); \`references\` is empty after a timeout. Fails with ` +
      "InvalidParams when the caller is no target and names none.",
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).optional().describe("Target id to read, e.g. `claude`. Default: the caller's own."),
      timeout: z
        .number()
        .positive()
        .max(INBOX_WAIT_MAX_S)
        .optional()
        .describe(`Seconds to wait, at most ${INBOX_WAIT_MAX_S}. Default ${INBOX_WAIT_DEFAULT_S}.`),
    }),
    result: InboxTakeResultSchema,
  },
  "script.outline": {
    description:
      "Outline a Markdown script (SPEC §5.5): frontmatter (`title`, `target_duration` in seconds, `aspect`) and its " +
      "scenes, one per `## ` heading, each with the `ref` to put in a clip's `scriptRef` (`scripts/launch.md#intro`, set " +
      "with `clip.set`) and the clips of every timeline already linked to it. Scenes with empty `clips` still need " +
      "footage or a composition. Top-level `clips` are linked to the whole script (`scriptRef` is the path without " +
      "`#anchor`), e.g. music or a full take; they cover no scene. `unresolved` lists clips pointing into this file at an anchor no scene has (renamed " +
      "or removed heading). A scene that names transcript words with `<!-- words: talk.words.json w_000010..w_000042 -->` under its heading (word ids repeat across transcripts: name the file; a bare range matching several transcripts is not placed) " +
      "has `wordRange`, and `span`: the timeline seconds those words occupy, per timeline, so you can place or re-place its clips; " +
      "unknown ids, an ambiguous range or a reversed range become `warnings`. " +
      "Never fails on content: bad frontmatter, duplicate headings or bad word ranges become `warnings`. Fails with " +
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
            span: z
              .array(SceneSpanSchema)
              .describe(
                "Where the scene's `wordRange` sits on each timeline that places any of those words (first to last placed word, " +
                  "through clips cut inside the range); empty when `wordRange` is null, unresolved, or no timeline places its words.",
              ),
          }),
        )
        .describe("In file order."),
      unresolved: z
        .array(ClipLocationSchema.extend({ scriptRef: z.string() }))
        .describe("Clips referencing this file at an anchor with no scene; fix with `clip.set` `scriptRef`."),
      warnings: z.array(z.string()).describe("Frontmatter problems, duplicate headings, bad word ranges, unreadable timelines or transcripts skipped."),
    }),
  },
  "script.check": {
    description:
      "Check a shoot script (ADR 0023): a script in `scripts/` with `shoot: true` that says, line by line, what each " +
      "person says on camera. Write it from the person's own script (any format), which stays untouched: name it in " +
      "`source` with `source_hash` (first 12 hex digits of its SHA-256). Returns the frontmatter, the speakers (each " +
      "with the `people.json` person of the same name, ignoring case), and per scene (`## ` heading; a closing timing " +
      "`(0:05–0:40)` is its `expected` length in seconds and is not part of the anchor) its lines: each non-blank text " +
      "line, its speaker (`**Name:**` holds until the next name), its spoken `words` and its cues (`[LABEL: text]`, " +
      "never spoken; `[FREE: …]` is unscripted speech checked only for presence and length). `source.stale` is true " +
      "when the original changed since: write the shoot script again from it. Never fails on content: unknown " +
      "speakers, a stale or missing source, empty scenes, leftover placeholders (`<…>`, `{{…}}`, `[TODO: …]`) and " +
      "frontmatter problems become `warnings`; clean when `warnings` is empty. Fails with ScriptNotFound (data lists " +
      "the scripts there are) or OutsideProject.",
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
      shoot: ShootMetaSchema,
      source: z
        .object({
          path: z.string().describe("Absolute path the frontmatter `source` resolves to (relative ones from the project root)."),
          found: z.boolean().describe("Whether the file exists and could be read."),
          hash: z.string().nullable().describe("First 12 hex digits of its SHA-256 now; null when not found."),
          stale: z.boolean().nullable().describe("True when `hash` differs from `source_hash`; null when either is unknown."),
        })
        .nullable()
        .describe("The person's original; null without a frontmatter `source`."),
      speakers: z
        .array(
          z.object({
            name: z.string().describe("Name as first written in the script."),
            person: z.string().nullable().describe("Id of the `people.json` person with this name (ignoring case); null when none."),
            lines: z.int().describe("Lines this speaker says."),
          }),
        )
        .describe("In order of first use; empty when the script names nobody (one speaker)."),
      scenes: z
        .array(ShootSceneSchema.extend({ ref: z.string().describe("`scriptRef` value for this scene: `<path>#<slug>`.") }))
        .describe("In file order."),
      warnings: z.array(z.string()).describe("Everything to fix before recording; empty when the script is clean."),
    }),
  },
  "voiceover.generate": {
    mutating: true,
    description:
      "Generate the voiceover of a voiceover script (ADR 0034): one spoken take per line, written to " +
      "`assets/voiceover/<script slug>/<line id>.wav` and imported (ingest queued) with one `asset.import`. A voiceover " +
      "script is a script in `scripts/` with `voiceover: true` in its frontmatter (also `language`, `provider`, `voice`), " +
      "read like a shoot script: one line per non-blank text line, `## ` scenes, `[LABEL: …]` cues never read. A " +
      "respelling `{display|spoken}` shows `display` and says `spoken` (`{Frameshell|freim shel}`); with `language: es` or " +
      "`en`, numbers with digits are spelled out for the voice and kept as digits in `display`. Line ids are " +
      "`<scene slug>-<n>` (`hook-1`). Each take is cached by its spoken text, provider (and its version), voice and " +
      "language: a line whose take is current is not generated again (`cached`), and one whose text moved to another " +
      "line id is copied (`copied`). Head and tail silence are trimmed with a little air kept. Each line also reports " +
      "its `phrases`: where the take falls silent for 60 ms or more (5 ms RMS, 38 dB under its peak), as ranges of the " +
      "take in seconds, the cuts of phrase clips (`clip add --in from --out to`); `phraseFade` is the 12 ms fade #470 asks for at each phrase edge, " +
      "which `voiceover.place` applies as the clips' audio fades. A person corrects the phrases by trimming the clips. With `verify` (default) each line's take is also " +
      "transcribed by the project's transcription provider and compared with the line's spoken text: `check` lists the " +
      "misreads, and `verification` says whether that ran. It is skipped, never a failure, when the project is not " +
      "trusted, has no transcription plugin or the transcription fails; the takes stay as they are. Nothing is placed " +
      "on a timeline. A paid provider (its cost estimate is above 0, or it gives no estimate and does not declare itself " +
      "free) generates nothing without `yes: true` and fails with ConfirmationRequired, whose data carries the cost " +
      "(`null` when unknown) and a `confirmation` token of what was priced (provider, voice, the lines to say and the cost): show it to the person and pass `yes` only after they confirm it, never on your own. " +
      "A client that showed the person the cost passes the token back as `confirmation`: when the lines or the cost changed since " +
      "(the script was edited, a take appeared, the provider's price moved) a paid run fails with ConfirmationStale, " +
      "carrying the current ask, and generates nothing; ask the person again. The " +
      "provider `command` is the TTS program the person set up on this machine (global `config.json` only); it is free. A second charge is prevented by the takes marked on disk and one run at a time per " +
      "project (a retry finds them `cached`); `idempotencyKey` only replays a result where a client sends one. A running " +
      "generation is not stopped by the caller disconnecting. Progress arrives as `progress` notifications. Fails with ScriptNotFound, " +
      "SpeechProviderNotFound (data lists the providers there are; `command` is missing until set up on the machine), ProjectNotTrusted (a plugin provider in an untrusted " +
      "project), ConfirmationStale (`confirmation` no longer matches the run), InvalidParams (no provider or voice named, unknown voice or line id; the message lists the valid " +
      "ones), InvalidOperation (a take file exists that this method did not write: it is never overwritten) or " +
      "SpeechFailed (the provider failed; takes finished before it are kept, imported and reused by the next call).",
    params: z.strictObject({
      cwd: CwdParam,
      script: z
        .string()
        .min(1)
        .describe("Voiceover script inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch-vo.md`."),
      lines: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Line ids to generate (`hook-1`, `problem-2`); default every line of the script."),
      provider: z
        .string()
        .min(1)
        .optional()
        .describe("Speech provider id. Default: the script's frontmatter `provider`."),
      voice: z
        .string()
        .min(1)
        .optional()
        .describe("Voice id of the provider. Default: the script's frontmatter `voice`, else the provider's default voice."),
      yes: z
        .boolean()
        .default(false)
        .describe("The person confirmed the cost of a paid provider. Never set it without their explicit confirmation."),
      confirmation: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The `confirmation` token of the ConfirmationRequired the person saw. A paid run whose lines or cost no longer match it " +
            "fails with ConfirmationStale instead of charging more than was confirmed. Without it `yes` confirms whatever the run costs.",
        ),
      verify: z
        .boolean()
        .default(true)
        .describe(
          "Transcribe each line's take with the project's transcription provider and compare it with the line (the misread " +
            "check). Takes a moment per line and may download the transcription model on first use; `false` skips it.",
        ),
    }),
    result: z.object({
      script: z.string().describe("Script file, project-relative and `/`-separated."),
      dir: z.string().describe("Folder of the takes, project-relative: `assets/voiceover/<script slug>`."),
      provider: z.string().describe("Speech provider used."),
      voice: z.string().describe("Voice used."),
      lines: z
        .array(
          VoiceoverLineSchema.omit({ cues: true, speaker: true, words: true }).extend({
            file: z.string().describe("The take, project-relative: `assets/voiceover/<script slug>/<id>.wav`."),
            state: z
              .enum(["generated", "cached", "copied"])
              .describe("`generated`: the provider said it now. `cached`: the file already held this take. `copied`: taken from the file of another line id with the same take."),
            duration: z.number().describe("Seconds of the take after trimming."),
            trimmed: z.object({ head: z.number(), tail: z.number() }).describe("Seconds of silence removed from the start and the end; 0 for `cached` and `copied`."),
            phrases: z
              .array(
                z.object({
                  from: z.number().describe("Start, seconds of the take."),
                  to: z.number().describe("End, seconds of the take."),
                  heard: z.string().nullable().describe("The words heard in this range; null when the line was not checked."),
                }),
              )
              .describe("The take split at its silences, in order (at least one): the ranges of the phrase clips."),
            check: z
              .object({
                status: z
                  .enum(["clean", "doubtful", "misread"])
                  .describe("`clean`: heard as written. `doubtful`: only differences the transcription may have made (numbers, close spellings, a respelled name). `misread`: the voice said something else."),
                heard: z.string().describe("Everything heard in the take."),
                misreads: z
                  .array(
                    z.object({
                      kind: z.enum(["missing", "changed", "added", "moved", "restart", "pause"]).describe("`missing`: not said. `changed`: said as other words. `added`: extra words. `moved`/`restart`: words repeated or out of place. `pause`: a silence of 1.5 s or more inside the line."),
                      expected: z.string().describe("What the spoken text has there."),
                      heard: z.string().describe("What was heard there; empty for `missing`."),
                      at: z.object({ start: z.number(), end: z.number() }).nullable().describe("Seconds of the take; null when nothing was heard."),
                      maybeTranscription: z.boolean().describe("The difference may be the transcription's, not the voice's."),
                    }),
                  )
                  .describe("Every difference, in order; empty when `clean`."),
              })
              .nullable()
              .describe("The misread check of this line; null when it did not run (see `verification`)."),
          }),
        )
        .describe("The lines asked for, in script order."),
      phraseFade: z.number().describe("The 12 ms fade at each phrase edge that #470 asks for, in seconds; `voiceover.place` applies it as each clip's `audio.fadeInMs`/`fadeOutMs`."),
      verification: z
        .object({
          status: z.enum(["checked", "skipped"]).describe("`skipped`: the misread check did not run; `reason` says why."),
          provider: z.string().nullable().describe("Transcription provider asked; null when not asked."),
          model: z.string().nullable().describe("Model it used, when known."),
          reason: z.string().nullable().describe("Why it was skipped (`verify: false`, an untrusted project, no transcription plugin, a failed transcription); null when checked."),
          misread: z.number().int().describe("Lines whose `check` is `misread`."),
          doubtful: z.number().int().describe("Lines whose `check` is `doubtful`."),
        })
        .describe("Whether the misread check ran. In an untrusted project it is skipped: the takes are generated and left unchecked."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("Takes this call wrote (`generated`, `copied`), imported together; follow their ingest with `job.list`."),
      cost: z
        .object({ amount: z.number(), currency: z.string() })
        .nullable()
        .describe("Estimated cost of the takes generated by this call; null when the provider is free or nothing was generated."),
      warnings: z.array(z.string()).describe("Script problems (budget over a scene's timing, digits without `language`…) and provider notes."),
    }),
  },
  "voiceover.place": {
    mutating: true,
    description:
      "Place the takes of a voiceover script (ADR 0034) on a timeline as phrase clips, in one transaction `Voiceover: …` " +
      "(one proposal in review mode; `revert` undoes it whole). Run `voiceover.generate` first: each line's take is read from " +
      "`assets/voiceover/<script slug>/<line id>.wav` (a line with no take fails and is named), cut at its silences into " +
      "phrases (the ranges `voiceover.generate` reports) and every phrase becomes a media clip of the take (`in`/`out` on " +
      "whole frames, `scriptRef` `<script>#<scene>`) on an audio track: `track`, else the one named `Voiceover`, made when absent. " +
      "The phrases of a line keep the spacing the take has. Where a line goes: `at` maps a line id (`hook-1`) or one phrase of it " +
      "(`hook-1.2`, counting from 1) to a time, given as seconds, a marker id or label (`hook`, `hook+0.5`) or a beat or bar of the timeline's " +
      "grid (`beat:9`, `bar:3`), resolved by the same TimeRef rules as every time argument; the clip starts on the frame nearest it, " +
      "so the first sound follows by 20 ms of air kept in the phrase. A line (or phrase) with no `at` follows the one before it by " +
      `\`gap\` seconds (default ${VOICEOVER_LINE_GAP_S}); the first one starts at \`start\`, else right after the track's last clip, else 0. ` +
      "Voice never overlaps itself: a phrase that would start before the previous one ends, or on a clip already on the track, fails " +
      "and names both, so move the anchor or drop it. Anchors must run in script order: an `at` earlier than the phrase before it " +
      "fails the same way even when nothing else is there. A line whose take is already on a timeline clip fails naming the clips unless " +
      "`replace` is true, which removes those clips first (use it after `voiceover.generate` changed a take: the old phrase " +
      "ranges no longer fit it). `dryRun` plans without writing. Every phrase clip gets the 12 ms phrase fade at both ends as sample-accurate " +
      "audio fades (`audio.fadeInMs`/`fadeOutMs`, as `clip.set` `audioFadeInMs`/`audioFadeOutMs` sets them), on top of the 20 ms before and 30 ms after " +
      "its sound each phrase keeps. A take said from older text than the line has now " +
      "is placed with a warning. Per-phrase tempo is not here (it waits for the preview pitch fix, #499). Fails with ScriptNotFound, " +
      "InvalidParams (unknown line id, `at` key or phrase number), InvalidOperation (not a voiceover script, a line with no take, an unknown " +
      "marker, a `track` that is not an audio track, overlap, clips already placed) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      script: z
        .string()
        .min(1)
        .describe("Voiceover script inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch-vo.md`."),
      lines: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Line ids to place (`hook-1`), default every line of the script, in script order."),
      at: z
        .record(z.string().min(1), TimeRefParam("Timeline time of the first sound of the line or phrase."))
        .optional()
        .describe("Where lines or phrases go: keys are line ids (`hook-1`, the same as `hook-1.1`) or one phrase (`hook-1.2`); lines and phrases left out follow the one before."),
      start: TimeRefParam("Timeline time of the first line when it has no `at`. Default: right after the last clip of the voice track, else 0.").optional(),
      gap: z
        .number()
        .min(0)
        .max(30)
        .default(VOICEOVER_LINE_GAP_S)
        .describe(`Seconds of air between a line and the next one that has no \`at\`. Default ${VOICEOVER_LINE_GAP_S}.`),
      track: z.string().min(1).optional().describe("Audio track for the voice, from `track.list`. Default: the audio track named `Voiceover`, made when absent."),
      replace: z
        .boolean()
        .default(false)
        .describe("Remove the clips that already play these lines' takes (on any track of the timeline) before placing. Default false: they make the call fail."),
      dryRun: z.boolean().default(false).describe("Plan and report without changing the timeline."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id."),
      revision: z.int().describe("Revision after the last change; the one before the call when nothing was written."),
      dryRun: z.boolean().describe("Nothing was written."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null on a dry run."),
      track: z
        .object({ id: z.string().nullable().describe("Null for a track a dry run would make."), name: z.string().nullable(), created: z.boolean().describe("This call made the track (a dry run: would make).") })
        .describe("The audio track the phrases went on."),
      script: z.string().describe("Script file, project-relative."),
      lines: z
        .array(
          z.object({
            id: z.string().describe("Line id."),
            start: z.number().describe("Timeline second of its first clip."),
            end: z.number().describe("Timeline second just after its last clip."),
            anchor: z.enum(["at", "start", "follows"]).describe("`at`: given by `at`. `start`: the first line, put at `start` or after the track's last clip. `follows`: after the previous line plus `gap`."),
          }),
        )
        .describe("The lines placed, in order."),
      placed: z
        .array(
          z.object({
            line: z.string().describe("Line id."),
            phrase: z.int().describe("Phrase number inside the line, from 1."),
            clip: z.string().nullable().describe("Id of the new clip; null on a dry run."),
            file: z.string().describe("The take, project-relative."),
            in: z.number().describe("Source seconds of the take where the clip starts, on the frame grid."),
            out: z.number().describe("Source seconds where it ends."),
            start: z.number().describe("Timeline second the clip starts, on the frame grid."),
            end: z.number().describe("Timeline second just after its last frame."),
            anchor: z.enum(["at", "start", "follows", "spacing"]).describe("`spacing`: a later phrase of a line, at the spacing the take has; the others as in `lines`."),
          }),
        )
        .describe("The phrase clips, in time order."),
      replaced: z.array(z.string()).describe("Ids of the clips removed by `replace`."),
      warnings: z.array(z.string()).describe("Takes older than their line, phrases shorter than a frame that were left out, and the engine's own warnings."),
    }),
  },
  "sound.sfx": {
    mutating: true,
    description:
      "Generate a sound effect (ADR 0038): synthesized offline from a seed, no network and no third-party samples. Kinds: " +
      "`click`, `tick`, `pop`, `whoosh` (stereo, swells to a peak at 45 % of its length), `riser` (a build that ends at its " +
      "peak), `thump`, `impact`, `shutter`; `variant` 1 to 3 is a different recipe of the kind. The same kind, variant, seed " +
      "(and `pitch`, `length` when given) always give the same file, so a set of sounds made with one `seed` shares a " +
      "timbre; vary `variant` and `seed` between uses (the same whoosh on every cut is the tell of a bad edit). Without " +
      "`pitch` the take gets a seeded pitch between 0.9 and 1.3 and a level within 1.5 dB. The take is a 48 kHz 16-bit WAV " +
      "written to `assets/sound/<kind>-<key>.wav` and imported (ingest queued) with one `asset.import`; the peak sits at " +
      "-3 dBFS give or take the jitter. A RIFF chunk inside the file holds its cache key and `peakAt`, the second of the " +
      "take that must land on the picture (the transient of a hit, the peak of a whoosh, the end of a riser): place a " +
      "take so that `peakAt` falls on the cue plus an offset by role (ms, negative = before the picture: tap -60, knock " +
      "-40, click -11, pop +30, whoosh peak +37, swell peak +42; a riser ends 75 ms before the hit). A take " +
      "that is already current is not written again (`cached`); nothing is placed on a timeline. When the project " +
      "keeps a `credits.json` ledger, the take is recorded in it with licence `own` (`credited`); without a ledger " +
      "nothing is written there. Fails with InvalidParams (a `length` for a kind that has none, or out of range) or " +
      "InvalidOperation (a file of that name exists that this method did not write: it is never overwritten).",
    params: z.strictObject({
      cwd: CwdParam,
      kind: SfxKindSchema.describe("What the sound is."),
      variant: z.number().int().min(1).max(SFX_VARIANTS).default(1).describe(`Recipe of the kind, 1 to ${SFX_VARIANTS}.`),
      seed: z
        .number()
        .int()
        .min(0)
        .max(SFX_SEED_MAX)
        .default(0)
        .describe("Family seed: the same seed gives the same file and a consistent timbre across kinds. Change it for another take of the same sound."),
      pitch: z
        .number()
        .min(SFX_PITCH_RANGE.min)
        .max(SFX_PITCH_RANGE.max)
        .optional()
        .describe(`Multiplier of every frequency. Default: a seeded value from ${SFX_JITTER.pitch.min} to ${SFX_JITTER.pitch.max}.`),
      length: z
        .number()
        .positive()
        .optional()
        .describe(
          `Seconds, only for ${Object.entries(SFX_LENGTH_RANGE)
            .map(([kind, range]) => `\`${kind}\` (${range.min} to ${range.max})`)
            .join(" and ")}; the other kinds have a fixed length. Default: the variant's own.`,
        ),
    }),
    result: z.object({
      kind: SfxKindSchema,
      variant: z.number().int(),
      seed: z.number().int(),
      pitch: z.number().describe("The pitch multiplier used, jitter included."),
      file: z.string().describe("The take, project-relative: `assets/sound/<kind>-<key>.wav`."),
      state: z.enum(["generated", "cached"]).describe("`generated`: written now. `cached`: the file already held this exact take."),
      duration: z.number().describe("Seconds."),
      channels: z.number().int().describe("2 for a whoosh, 1 otherwise."),
      peakAt: z.number().describe("Seconds from the start of the take to the instant that must land on the cue."),
      peakDb: z.number().describe("Sample peak, dBFS."),
      rmsDb: z.number().describe("RMS over the whole take, dBFS."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("The take when this call wrote it, imported; empty when `cached`. Follow its ingest with `job.list`."),
      credited: z.boolean().describe("The project's `credits.json` holds an `own` entry for the take. False when the project keeps no ledger."),
    }),
  },
  "sound.place": {
    mutating: true,
    description:
      "Place generated sound effects (ADR 0038) on a timeline, in one transaction `Sound: …` (one proposal in review mode; " +
      "`revert` undoes it whole). Each sound is made like `sound.sfx` (reused when the same take exists, else written to " +
      "`assets/sound/` and imported) and put on an audio track so that the instant of the take that must meet the picture " +
      "(`peakAt`: the transient of a hit, the peak of a whoosh, the end of a riser) falls on its cue plus an offset by role " +
      `(ms, negative = before the picture: ${Object.entries(SOUND_ROLE_OFFSETS).map(([role, ms]) => `${role} ${ms}`).join(", ")}; ` +
      `a riser ends ${SOUND_RISER_END_BEFORE_MS} ms before the cue). Without \`role\` a kind takes its own (click and shutter \`click\`, tick \`tap\`, ` +
      "pop and thump `pop`, whoosh `whoosh`, impact `knock`); `offset` (ms) replaces the table. A clip starts on a frame, so a sound lands within half " +
      "a frame of where asked, and it plays whole frames (a sound shorter than one frame is skipped, with a reason). " +
      "Three ways to say where: `cues` (each with `at`: seconds, a marker id or label, optionally `hook+0.5`), `cuts` (the edit point at the start of every clip after the first of a video " +
      "or audio `track`, or only the numbered ones in `which`) and `typing` (a run of keys between `from` and `to`, " +
      `${SOUND_TYPING_RATE.default} keys a second by default, at most ${SOUND_TYPING_RATE.max}, spaced at least ${SOUND_KEY_GAP_MS} ms apart (a warning when whole frames bring two keys closer), with a seeded ±10 % timing jitter ` +
      "and rotating takes). Sounds go on the audio track named `SFX` (made when absent) or on `track`; sounds that overlap in time " +
      "go on further tracks `SFX 2`, `SFX 3`… The clip `gain` (dB) is minus the style's `sound.sfxUnderVoice` (20 by default) " +
      `plus the tier: ${Object.entries(SOUND_TIER_OFFSETS_DB).map(([tier, db]) => `${tier} ${db}`).join(", ")} dB (\`gain\` replaces it). ` +
      "Without `variant` the takes of one kind rotate through variants 1 to 3 along the timeline, so the same whoosh is never twice in a row. " +
      "Taste is a warning, never a refusal: the call warns (`warnings`) when more than " +
      `${SOUND_MAX_PER_FRAME} sounds land on one frame, when two sounds of one kind are closer than their minimum gap ` +
      `(${Object.entries(SOUND_MIN_GAP_MS).map(([kind, ms]) => `${kind} ${ms} ms`).join(", ")}) and when one take plays twice in a row, counting sounds already on the timeline. ` +
      "Example: `{ cues: [{ at: \"hook\", kind: \"whoosh\" }, { at: 6.2, kind: \"click\", seed: 3 }] }`. " +
      `At most ${SOUND_MAX_PLACEMENTS} sounds per call. Fails with InvalidParams (nothing to place), InvalidOperation (an unknown ` +
      "marker, a `track` that is not an audio track, a hand-made file in the way of a take) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      cues: z.array(SoundCueSchema).min(1).optional().describe("Sounds at given times; each is one sound."),
      cuts: SoundCutsSchema.optional().describe("Sounds on the edit points of a track."),
      typing: SoundTypingSchema.optional().describe("A run of key sounds between two times."),
      track: z
        .string()
        .min(1)
        .optional()
        .describe("Audio track for the sounds, from `track.list`. Default: the audio track named `SFX`, made when absent."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id."),
      revision: z.int().describe("Revision after the last change; the one before the call when nothing was placed."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null when nothing was placed."),
      tracks: z
        .array(z.object({ id: z.string(), name: z.string().nullable(), created: z.boolean().describe("This call made the track.") }))
        .describe("The audio tracks the sounds went on, first lane first."),
      placed: z
        .array(
          z.object({
            clip: z.string().describe("Id of the new clip."),
            track: z.string(),
            file: z.string().describe("The take, project-relative: `assets/sound/<kind>-<key>.wav`."),
            state: z.enum(["generated", "cached"]).describe("`generated`: this call wrote the take. `cached`: it already existed."),
            kind: SfxKindSchema,
            role: SoundRoleSchema.nullable().describe("Role whose offset applied; null for a riser's own rule or an `offset` given."),
            tier: SoundTierSchema,
            from: z.enum(["cue", "cut", "typing"]).describe("Which part of the call asked for it."),
            cue: z.number().describe("Timeline second the sound belongs to."),
            offset: z.number().describe("Milliseconds from the cue to the take's anchor that were used."),
            start: z.number().describe("Timeline second the clip starts, on the frame grid."),
            in: z.number().describe("Source seconds cut off the head of the take; above 0 only when it would start before the timeline does."),
            anchorAt: z.number().describe("Timeline second where the take's anchor falls after rounding to frames."),
            gain: z.number().describe("Clip gain, dB."),
          }),
        )
        .describe("The clips made, in time order."),
      skipped: z
        .array(z.object({ cue: z.number(), kind: SfxKindSchema, reason: z.string() }))
        .describe("Sounds asked for and not placed, with why (shorter than one frame, would start before the timeline)."),
      generated: z.int().describe("Takes this call wrote (the others were reused)."),
      warnings: z.array(z.string()).describe("Crowded frames, short gaps, a take twice in a row, trimmed heads, and the engine's own warnings."),
    }),
  },
  "sound.music": {
    mutating: true,
    description:
      "Generate a music bed (ADR 0038): a seeded 16-step sequencer synthesized offline, no network and no third-party samples. " +
      `Presets: \`synthwave\` (${MUSIC_PRESET_DEFAULTS.synthwave.bpm} BPM, ${MUSIC_PRESET_DEFAULTS.synthwave.chords.join("-")}, saw chords, ` +
      `four on the floor), \`lofi\` (${MUSIC_PRESET_DEFAULTS.lofi.bpm} BPM, ${MUSIC_PRESET_DEFAULTS.lofi.chords.join("-")}, electric piano, swung ` +
      `hats, vinyl, dark), \`minimal\` (${MUSIC_PRESET_DEFAULTS.minimal.bpm} BPM, FM mallet stabs, plucked bass, metallic hats, no pads). ` +
      "The track has whole bars (`bars`, or as many as fit `length` seconds, or with `place` and neither, as many as fit from " +
      "`at` to the end of the timeline) made of `sections`: `intro`, `full`, `dark` (stripped: pad, sub, soft kick, for under a " +
      "voice or a dense picture), `build` (a climbing motif, a clap roll and a riser that ends 75 ms before the next part), " +
      "`gap` (one stop-time hit, then silence so the next downbeat lands hard), `drop` (everything, a crash and a big kick on " +
      "its first beat), `outro` (half time). Without `sections` it is intro, full, build and drop (from 8 bars), outro. A " +
      "section's `at` (a time on the timeline) starts it on the nearest bar, so a drop can land on a marker. Every track ends " +
      "on a final hit, the first chord with a crash and a big kick on the downbeat after its last bar, that rings for " +
      `${MUSIC_TAIL_SECONDS} s; \`accents\` add a crash and a big kick on the nearest beat (a logo, a call to action). The same ` +
      "arguments always give the same file. The take is a 48 kHz 24-bit stereo WAV at " +
      `${MUSIC_LUFS} LUFS with its sample peak at most ${MUSIC_PEAK_DBFS} dBFS, written to \`assets/sound/music-<preset>-<key>.wav\` and imported; ` +
      "beside it the call writes its exact beat grid `beats/<name>.beats.json` (`detector: \"exact\"`, confidence 1, the " +
      "downbeat at 0, the final hit and accents as `onsets`), so nothing measures it and later calls' `beat:`/`bar:` times, `--snap-to " +
      "beat` and `music.fit` can use it at once (this call's own `at`, section and accent times take seconds and markers only). With `place` (default) the call also puts the take on the timeline in one " +
      "transaction `Music: …` (one proposal in review mode; `revert` undoes it): a clip starting at `at` (default 0) on the " +
      "audio track named `Music` (made when absent; `Music 2`… when the time is taken) or on `track`, with `gain` minus the " +
      "style's `sound.musicUnderVoice` (12 dB by default), and when the timeline has no `tempo` yet, `tempo` set to follow " +
      "the new clip; an existing tempo is kept, with a warning. `place: false` only writes and imports the take. When the " +
      "project keeps a `credits.json`, the take is recorded as `own` work. Fails with InvalidParams (no length to go by, " +
      "bars and sections that disagree, too long) or InvalidOperation (an unknown marker, a `track` that is not an audio " +
      "track or is taken at that time, a hand-made file in the way of the take).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      preset: MusicPresetSchema.describe("Genre: instruments, groove, default tempo and chords."),
      bpm: z
        .number()
        .min(MUSIC_BPM_RANGE.min)
        .max(MUSIC_BPM_RANGE.max)
        .optional()
        .describe(`Tempo, ${MUSIC_BPM_RANGE.min} to ${MUSIC_BPM_RANGE.max} BPM. Default: the preset's.`),
      meter: z.int().min(MUSIC_METER_RANGE.min).max(MUSIC_METER_RANGE.max).default(4).describe("Beats per bar. Default 4."),
      bars: z.int().min(1).max(MUSIC_MAX_BARS).optional().describe("Length in bars, before the final hit and its ring."),
      length: z
        .number()
        .positive()
        .max(MUSIC_MAX_SECONDS)
        .optional()
        .describe("Length in seconds: the track gets the whole bars whose end (the final hit) is nearest to it. Not with `bars`."),
      sections: z
        .array(
          z.strictObject({
            kind: MusicSectionSchema,
            bars: z.int().min(1).max(MUSIC_MAX_BARS).optional().describe("Bars of this part. Default: up to the next part's `at`, or to the end for the last."),
            at: TimeRefParam("Timeline time this part starts at, moved to the nearest bar of the track. Default: right after the part before.").optional(),
          }),
        )
        .min(1)
        .max(MUSIC_LIMITS.sections)
        .optional()
        .describe("The parts in order; the first starts the track. Default: intro, full, build, drop, outro by length."),
      chords: z
        .array(z.string().regex(MUSIC_CHORD_PATTERN, "a root (`A`, `C#`, `Bb`) and a quality (`m`, `7`, `maj7`, `m7`, `9`, `m9`, `13`, `sus4`…)"))
        .min(1)
        .max(MUSIC_LIMITS.chords)
        .optional()
        .describe("One chord per bar, repeating, e.g. `[\"Am\", \"F\", \"C\", \"G\"]`; the melody uses the minor pentatonic of the first. Default: the preset's."),
      accents: z
        .array(TimeRefParam("Timeline time of an accent, moved to the nearest beat."))
        .min(1)
        .max(MUSIC_LIMITS.accents)
        .optional()
        .describe("Times that get a crash and a big kick (a logo, a call to action)."),
      seed: z.number().int().min(0).max(SFX_SEED_MAX).default(0).describe("Seed of the melody, grooves and noise: change it for another track with the same settings."),
      place: z.boolean().default(true).describe("Put the take on the timeline (default). False: only write and import it."),
      at: TimeRefParam("Timeline time the track starts at. Default 0.").default(0),
      track: z.string().min(1).optional().describe("Audio track for the clip, from `track.list`. Default: the audio track named `Music`, made when absent."),
      gain: z.number().min(-60).max(12).optional().describe("Clip gain in dB, replacing minus the style's `sound.musicUnderVoice`."),
    }),
    result: z.object({
      file: z.string().describe("The take, project-relative: `assets/sound/music-<preset>-<key>.wav`."),
      state: z.enum(["generated", "cached"]).describe("`generated`: written now. `cached`: the file already held this exact take."),
      preset: MusicPresetSchema,
      bpm: z.number(),
      meter: z.int(),
      bars: z.int().describe("Bars before the final hit."),
      seed: z.int(),
      chords: z.array(z.string()).describe("The chords played, one per bar, repeating."),
      sections: z
        .array(z.object({ kind: MusicSectionSchema, bars: z.int(), start: z.number().describe("Seconds into the take.") }))
        .describe("The parts as played."),
      duration: z.number().describe("Seconds of the take, the ring after the final hit included."),
      hitAt: z.number().describe("Seconds into the take of the final hit: the downbeat after the last bar. `music.fit` lands it on a cut."),
      lufs: z.number().describe("Integrated loudness, LUFS."),
      peakDb: z.number().describe("Sample peak, dBFS."),
      beats: z
        .object({
          file: z.string().describe("The beat grid, project-relative: `beats/<name>.beats.json`."),
          state: z.enum(["written", "kept"]).describe("`kept`: an exact grid for this take was already there (its `edits` too)."),
          count: z.int().describe("Beats in the grid, the final hit included."),
        })
        .describe("The exact beat grid of the take."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("The take when this call wrote it, imported; empty when `cached`. Follow its ingest with `job.list`."),
      credited: z.boolean().describe("The project's `credits.json` holds an `own` entry for the take. False when the project keeps no ledger."),
      timeline: z.string().nullable().describe("Timeline id; null with `place: false`."),
      revision: z.int().nullable().describe("Revision after the change; null with `place: false`."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null with `place: false`."),
      track: z
        .object({ id: z.string(), name: z.string().nullable(), created: z.boolean().describe("This call made the track.") })
        .nullable()
        .describe("Audio track of the new clip; null with `place: false`."),
      clip: z.string().nullable().describe("Id of the new clip; null with `place: false`."),
      start: z.number().nullable().describe("Timeline second the clip starts, on the frame grid."),
      gain: z.number().nullable().describe("Clip gain, dB."),
      tempo: z
        .enum(["set", "kept"])
        .nullable()
        .describe("`set`: the timeline's tempo now follows the new clip. `kept`: the timeline already had a tempo, left as it was. Null with `place: false`."),
      warnings: z.array(z.string()),
    }),
  },
  "shoot.status": {
    description:
      "Where a shoot is (ADR 0023): every scene of the shoot script with its state (`none`, `deviations`, `done`), the " +
      "take chosen for it (the newest covering it unless picked with `shoot.choose`) and how many deviations wait; " +
      "every take with how it said each line and every deviation (missing, changed, added, moved, restart, pause, " +
      "speaker, length, free) with its `accepted` flag; `next`, the first scene in script order not done (never " +
      "enforced); and the cues. Takes are compared against their asset's transcript when asked (cached): a take " +
      "whose asset has no transcript says so in `problem`. Reacting to a newly analyzed take without being asked is " +
      "fine (placing b-roll of a scene that just became done); never accept deviations or record in the person's " +
      "place unless asked. Fails with ScriptNotFound, OutsideProject or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch.md`."),
    }),
    result: z.object({
      script: z.string().describe("Shoot script, project-relative."),
      file: z.string().describe("Shoot file, project-relative (`shoots/<slug>.json`); it may not exist yet."),
      timeline: z.string().describe("Timeline the first cut goes into."),
      scenes: z.array(ShootSceneStatusSchema).describe("In script order."),
      takes: z.array(TakeInfoSchema).describe("Oldest first, discarded ones included."),
      next: z.string().nullable().describe("Slug of the first scene not done; null when every scene is done."),
      cues: z
        .array(
          z.object({
            scene: z.string(),
            line: z.int().describe("1-based file line."),
            label: z.string(),
            text: z.string().nullable(),
            free: z.boolean(),
            time: z
              .number()
              .nullable()
              .describe("Timeline seconds of the cue in the assembled timeline (`shoot.assemble`), from the words around it; null until its scene is assembled."),
          }),
        )
        .describe("Every cue of the script in order, for placing visuals (`[VISUAL: …]` becomes a clip or overlay at `time`)."),
      warnings: z.array(z.string()).describe("`script check` warnings of the script, and takes that point at a missing asset or scene."),
      transcription: z
        .object({
          provider: z.string().describe("`transcription.provider` of the project, else `whisper-cpp`."),
          ready: z.boolean().describe("True when that provider loads here, so takes get their words."),
          problem: z
            .string()
            .nullable()
            .describe(
              "Why it does not (not installed, plugin failed to load, project not trusted) and how to fix it; null when ready. " +
                "Takes cut meanwhile fail and are transcribed again once a plugin is installed.",
            ),
        })
        .describe("Whether takes can be transcribed in this project; check it before recording."),
    }),
  },
  "shoot.add": {
    mutating: true,
    description:
      "Link an existing media file as a take of a shoot script (ADR 0023), starting at `scene` (default the first). " +
      "It is compared against the script once the file has a transcript (`transcribe` it first, with `--speakers` " +
      "when several people speak). The id is generated (`k_` + 6 hex). Undo with `shoot.discard`. Fails with " +
      "ScriptNotFound, AssetNotFound, OutsideProject, InvalidOperation (unknown scene) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, e.g. `scripts/launch.md`."),
      asset: z.string().min(1).describe("Media file inside the project, absolute or relative to `cwd`, e.g. `assets/hook-2.mp4`."),
      scene: z.string().min(1).optional().describe("Slug of the scene the take starts at; default the first scene."),
      recordedAt: z.string().min(1).optional().describe("ISO 8601 time it was recorded; default now. Newer takes are chosen by default."),
    }),
    result: z.object({ file: z.string().describe("Shoot file written, project-relative."), take: TakeInfoSchema }),
  },
  "shoot.assemble": {
    mutating: true,
    description:
      "Build the first cut of a shoot (ADR 0023) in its timeline (`timeline` of `shoot.status`, created when missing): per " +
      "scene, in script order, the chosen take from its first to its last line, restarts and pauses over 1.5 s cut out, " +
      "0.15 s handles, edges snapped into pauses (`snap: false` keeps them exact), each clip linked to its scene " +
      "(`scriptRef`) and carrying its take (`take`). A scene already assembled is replaced in place and what follows " +
      "moves by the change in length; a scene whose take did not change is left alone. Only clips carrying one of the " +
      "shoot's takes are removed: clips, overlays and subtitles anyone else placed stay. One transaction (label " +
      "`Assemble <scene>`, or `Assemble <script>` for several), undone with `revert`; held as a proposal in review mode. " +
      "Then place the visuals from the cues' `time` in `shoot.status`. Fails with ScriptNotFound, InvalidProjectFile or " +
      "the timeline operations' errors.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, e.g. `scripts/launch.md`."),
      scenes: z.array(z.string().min(1)).min(1).optional().describe("Scene slugs to (re)assemble; default every scene."),
      snap: z.boolean().default(true).describe("Snap clip edges into audio pauses (ADR 0003)."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id written."),
      created: z.boolean().describe("True when the timeline file was created by this call."),
      tx: z.string().nullable().describe("Transaction id, for `revert`; null when nothing changed."),
      scenes: z
        .array(
          z.object({
            slug: z.string(),
            take: z.string().nullable(),
            action: z
              .enum(["placed", "unchanged", "removed", "none", "waiting"])
              .describe(
                "`placed`: new clips. `unchanged`: already as planned. `removed`: old clips taken out, no take covers it now. `none`: nothing to place. " +
                  "`waiting`: its take was recorded in the app and its session still records; it becomes shots of the session's program track when the session ends.",
              ),
            clips: z.array(z.string()).describe("Clip ids of the scene now."),
          }),
        )
        .describe("Scenes assembled, in script order."),
      warnings: z.array(z.string()),
    }),
  },
  "shoot.discard": {
    mutating: true,
    description:
      "Set a take aside: it stays listed but is never chosen, and a scene that had it picked goes back to the newest " +
      "take. `restore: true` brings it back (the inverse). Fails with InvalidOperation (unknown take), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      take: z.string().min(1).describe("Take id, e.g. `k_3fa2c1`."),
      restore: z.boolean().default(false).describe("Undo an earlier discard."),
    }),
    result: z.object({ file: z.string(), take: z.string(), discarded: z.boolean() }),
  },
  "shoot.accept": {
    mutating: true,
    description:
      "Let deviations of a take pass (ADR 0023): the given ids, or every current one when `deviations` is left out " +
      "(the whole take). An accepted deviation stays accepted while its script line and heard words stay the same. " +
      "`undo: true` takes the acceptance back (the inverse). Accept only what the person asked for. Fails with " +
      "InvalidOperation (unknown take, a deviation id the take does not have now, or a take not analyzed yet), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      take: z.string().min(1).describe("Take id."),
      deviations: z.array(z.string().min(1)).min(1).optional().describe("Deviation ids from `shoot.status`; default all of the take's."),
      undo: z.boolean().default(false).describe("Take the acceptance back."),
    }),
    result: z.object({ file: z.string(), take: z.string(), deviations: z.array(z.string()).describe("Ids whose acceptance changed.") }),
  },
  "shoot.choose": {
    mutating: true,
    description:
      "Pick the take that goes into the cut for a scene, or `take: null` to go back to the default (the newest take " +
      "covering it). Choosing again with the previous value is the inverse. Fails with InvalidOperation (unknown " +
      "scene or take, a discarded take, or one that does not cover the scene), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      scene: z.string().min(1).describe("Scene slug."),
      take: z.string().min(1).nullable().describe("Take id, or null for the default."),
    }),
    result: z.object({ file: z.string(), scene: z.string(), take: z.string().nullable(), previous: z.string().nullable().describe("What was picked before; null = the default.") }),
  },
  "shoot.session.cut": {
    mutating: true,
    internal: true,
    description:
      "The app's Cut (ADR 0024 decision 4): add a take that is the range `start`..`end` of a session still recording, then " +
      "queue a `shoot` job that cuts that range of each sound file to 16 kHz mono PCM, transcribes it with the project's " +
      "model and compares it with the script (`shoot.changed` `analyzed`). Sound files are read as they grow (`<file>.part`).",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      scene: z.string().min(1).describe("Scene the take starts at: the one the Shoot view shows as current."),
      session: ShootSessionIdSchema,
      start: z.number().nonnegative().describe("Session-clock second of `T`."),
      end: z.number().positive().describe("Session-clock second of `C`."),
      sounds: z.array(SessionSoundSchema).min(1).describe("Microphone first, then system audio."),
      recordedAt: z.string().min(1).optional().describe("ISO 8601 time of `T`; default now."),
    }),
    result: z.object({ file: z.string(), take: TakeInfoSchema, job: JobSchema }),
  },
  "shoot.session.end": {
    mutating: true,
    internal: true,
    description:
      "End a session that has takes (ADR 0024 decisions 1 and 4), its files final: wait for its takes' `shoot` jobs (and run " +
      "again, on the final files, those of takes left without words), write the takes' words as the transcripts of its sound files, make the session one multicam group (as `multicam.create` with " +
      "`offsets`) on the shoot's timeline, created when missing, without the first covering shot, and assemble the shoot, so " +
      "the session's chosen takes become shots of the group's program track.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script whose takes the session holds."),
      session: ShootSessionIdSchema,
      assets: z.array(z.string().min(1)).describe("Picture files (camera, screen), as `multicam.create` takes them; empty: no group."),
      names: z.array(z.string().min(1)).optional(),
      mics: z.array(z.string().min(1)).optional(),
      micNames: z.array(z.string().min(1)).optional(),
      soundOf: z.array(z.string().min(1)).optional(),
      offsets: z.array(z.number().nonnegative()).describe("One per file, pictures then mics."),
      screens: z.array(z.int().min(1)).optional(),
      name: z.string().min(1).optional(),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline the group went to: the shoot's."),
      group: z.string().nullable().describe("New group; null when nothing had a picture."),
      transcripts: z.array(z.string()).describe("Transcript files written, project-relative."),
      tx: z.string().nullable().describe("Transaction of the assembly; null when nothing changed."),
      warnings: z.array(z.string()),
    }),
  },
  "timeline.show": {
    description:
      "Compact dump of a timeline for agents: revision, project fps, derived duration, and every track with its clips " +
      "(ids, type, asset/source, `start`/`end` in timeline seconds, `in`/`out` in source seconds, speed, audio, transform). " +
      "Read this before editing and use the returned ids. A clip whose nested timeline file is missing or invalid has " +
      "`end: null` and is listed in `problems` with the fix. In review mode, `view` picks the file or the open " +
      "proposal's version (default: yours when the proposal is yours). Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      view: ViewParam,
      grid: z
        .boolean()
        .optional()
        .describe("True adds `grid`: the beat grid of the timeline's `tempo` with every beat and bar start in timeline seconds (can be long). Default false; `tempo.show` reads it alone."),
    }),
    result: TimelineViewSchema.extend(ViewedShape),
  },
  "track.list": {
    description:
      "List a timeline's tracks in stacking order (first video track = bottom layer): id, kind, name, followed track, " +
      "clip count and end time (null while a clip's nested timeline is missing or invalid; see `problems`). " +
      "In review mode, `view` picks the file or the open proposal's version. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
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
      "`style` (`preset`: `big-keyword` or `plain`; `position`: `top`, `center` or `bottom`; `speakerNames`: true shows the " +
      "speaker's name at each turn; `entry`: `none`, `chars`, `words` or `line` softly fades the text in; `keywordColor` / " +
      "`keywordScale` style the keyword `captions.set` marks, null colour = none; given fields change, others stay) and `gaps` " +
      "(timeline-second ranges in which no cue shows, e.g. while a graphic says the same; replaces them, `[]` clears). " +
      "Example: `{ track: \"t_4d5e6f\", style: { position: \"top\" }, gaps: [{ from: 12, to: 15.5 }] }`. Preview and export use the same style. " +
      "`muted: true` silences a video, audio or program track whatever its clips' own audio; `hidden: true` leaves a video or " +
      "program track's pictures out (the tracks below show through, its sound still plays); false undoes either. " +
      "`behind: \"<plate track>\"` puts a video track's pictures behind the person in front on a lower video track (ADR 0032): " +
      "a big word or a logo between the background and the person. Export draws the plate's media clips again above this " +
      "track through each asset's subject matte (`matte.prepare`), waiting for a matte that is not made yet (about 1.5 min " +
      "per min of video); the preview does not show it yet. Keep the word 30-55 % covered and never over the face. " +
      "`behind: null` clears it; removing or moving the plate track so it is no longer below clears it too, with a warning. " +
      "`format` (ADR 0027, a format other than the primary) with `style` sets a subtitle track's captions in that format only, " +
      "e.g. `{ track, format: \"9x16\", style: { position: \"center\" } }` (a vertical format still draws them 1.3x larger); " +
      "`reset: true` drops that format's style first. " +
      "Fails with TrackNotFound, FormatNotFound or InvalidOperation (style or follows on a clip track, muted on a subtitle track, hidden on an " +
      "audio or subtitle track, behind on a track that is not video, a plate that is not a lower video track, or in an image " +
      "project, `format` on a clip track or with another field than `style`, nothing to change).",
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
  "multicam.create": {
    mutating: true,
    description:
      "Make a multicam group from cameras (one file per camera or person) and, optionally, separate mic files (ADR 0016). Measures " +
      "every file's offset by audio cross-correlation (the sound they share: a clap, the room, bleed from the other mic) against " +
      "ALL the others, not only the first: each file is placed by its best match with a file already placed, so a camera whose " +
      "sound is faint still lands through the mic that hears the same room. The earliest file starts at 0, then the group, a " +
      "program track and one `grid` shot over the cameras' length are added. A camera's sound is its own file's unless a mic " +
      "carries it: `soundOf` has one entry per camera, a 1-based index into `mics`, `none` (wide camera: no sound) or `camera` " +
      "(its own file). Default: the camera n takes mic n while there are mics, the rest keep their own file; one mic may serve " +
      "several cameras. Example: `{ assets: [\"assets/wide.mp4\", \"assets/ana.mp4\", \"assets/ben.mp4\"], mics: [\"assets/ana.wav\", " +
      "\"assets/ben.wav\"], soundOf: [\"none\", \"1\", \"2\"] }`. `sync` reports each file's offset, `confidence` (0 to 1) and the file it " +
      "was matched `against`. Below 0.5 no trustworthy match was found: that file is not shifted (it starts with the reference), " +
      "`synced` is false and a warning says so; check it by ear or eye, then fix it with `multicam.offset` (cameras) or " +
      "`multicam.mic` (mics). Only the first ten minutes of each file are matched. Needs two or more cameras with a picture; " +
      "the reference is the first file with sound; a file without sound is not synced. With `offsets` (known start times, e.g. " +
      "from one recorder's clock) nothing is matched: one camera is enough (its shot is then `solo`), no file needs sound, and " +
      "`sync` reports `confidence` and `against` null. `screens` marks cameras that are screen shares (as `multicam.angle` `screen`). " +
      "Fails with InvalidOperation (file missing or unreadable, no picture, no file with sound, outside the project, bad `soundOf`).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      assets: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Camera files with a picture, inside the project, absolute or relative to `cwd`; the first one sets the clock unless it has no sound. " +
            "Two or more unless `offsets` is given.",
        ),
      names: z.array(z.string().min(1)).optional().describe("Angle names in the same order, e.g. the people. Default: file names."),
      mics: z.array(z.string().min(1)).optional().describe("Separate sound files (audio or video files; only the sound is used), same rules as `assets`."),
      micNames: z.array(z.string().min(1)).optional().describe("Mic names in the same order as `mics`. Default: file names."),
      soundOf: z
        .array(z.string().min(1))
        .optional()
        .describe("One entry per camera, in order: a 1-based index into `mics`, `none` or `camera`. Default: see the description."),
      name: z.string().min(1).optional().describe("Name of the group and its program track. Default track name `Multicam`."),
      offsets: z
        .array(z.number().nonnegative())
        .optional()
        .describe(
          "Known offsets instead of matching sound: one per file, cameras then mics, the group-clock second at which the file's time 0 plays, " +
            "e.g. `[0, 0.012, 0.003]`. Default: measured.",
        ),
      screens: z
        .array(z.int().min(1))
        .optional()
        .describe("1-based numbers of the cameras that are screen shares, e.g. `[2]`. Default: none."),
    }),
    result: MulticamCreateResultSchema,
  },
  "multicam.gallery": {
    mutating: true,
    description:
      "Make a multicam group from one gallery-view call recording (Zoom, Meet, Teams: every person in a tile of one picture; " +
      "ADR 0016). Finds the tile grid by its gutters (lines of one flat colour between tiles) on frames sampled across the " +
      "whole file, then adds one angle per tile, each a `crop` of the same file in reading order (rows top to bottom, each " +
      "left to right), a program track and one `grid` shot over the recording. The file's sound plays once for all tiles " +
      "through one group mic (`mic`): every tile hears the same mixed track, so they speak together for `multicam.turns` " +
      "until that file's transcript has speakers (`transcribe`, then `transcribe.speakers`; then name each tile's `speaker` " +
      "with `multicam.angle`). Each tile reports a `confidence` (0 to 1); below 0.5 check it on a frame and fix it with " +
      "`multicam.angle` `crop`. `layouts` lists the stretches of the call with their tile count: when the layout changes " +
      "mid-call (someone joins or leaves, a screen share) a warning gives the times; the angles follow the layout held " +
      "longest, or the one playing at `at`. Gallery recordings only: a speaker-view or single-camera file has no grid. " +
      "A call recorded in the app's Shoot view (ADR 0024) is already a group with the call window as a screen angle: pass " +
      "`group` (and `mic`, the group mic of the call's system audio) to add the tiles to that group at the window's offset, " +
      "keeping its shots. " +
      "Example: `{ asset: \"assets/call.mp4\", names: [\"Ana\", \"Ben\", \"Zoe\"] }`. Fails with InvalidOperation (file " +
      "missing, outside the project or without a picture, no tile grid found, `at` in a stretch without one, wrong number " +
      "of `names`: data has the tile count; with `group`, no such group or mic, no angle of it playing `asset`, or its tiles added already), or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      asset: z.string().min(1).describe("Gallery recording inside the project, absolute or relative to `cwd`, e.g. `assets/call.mp4`."),
      names: z
        .array(z.string().min(1))
        .optional()
        .describe("Angle names in reading order, one per tile, e.g. the people. Default `Tile 1`, `Tile 2`, …"),
      name: z.string().min(1).optional().describe("Name of the group and its program track. Default track name `Multicam`."),
      at: z
        .number()
        .nonnegative()
        .optional()
        .describe("Recording second whose layout the tiles are cut from. Default: the layout held longest."),
      group: operationArgs["multicam.gallery"].shape.group,
      mic: operationArgs["multicam.gallery"].shape.mic,
    }),
    result: MulticamGalleryResultSchema,
  },
  "multicam.offset": {
    mutating: true,
    description:
      "Fix one angle's sync by hand: set `offset`, the group-clock second at which its file's time 0 plays (absolute, not a nudge: " +
      "a smaller offset makes the angle play earlier against the others). Offsets cannot be negative: to start an angle before " +
      "the others, raise the others' offsets. Example: `{ group: \"g_1a2b3c\", angle: \"ben\", offset: 1.42 }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, or when a shot would then play past the group's end " +
      "(trim those shots first).",
    params: operationArgs["multicam.offset"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.mic": {
    mutating: true,
    description:
      "Change one separate mic of a multicam group: `name`, `offset` (group-clock second at which its file's time 0 plays, absolute; " +
      "fixes its sync) and its sound under every shot (`gain` dB, `muted`). The mic plays once, whichever angles use it. " +
      "Example: `{ group: \"g_1a2b3c\", mic: \"ana-lav\", offset: 0.84, gain: -2 }`. Pick which mic an angle uses with `multicam.angle`. " +
      "Fails with InvalidOperation when the group or mic does not exist or nothing is given.",
    params: operationArgs["multicam.mic"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.angle": {
    mutating: true,
    description:
      "Change one angle of a multicam group: `name`, `crop` (fractions of its picture cut off each side, merged side by side; " +
      "null removes it), its sound under every shot (`gain` dB, `muted`: the angle's own file; with a mic they belong to the mic, see " +
      "`multicam.mic`), where it is heard (`mic`: a mic id of the group, `camera` for its own file, `none` for no sound), `screen` " +
      "(true: a screen share, which the director shows while it moves, never as a speaker) and `speaker`: the transcript speaker (`s1`, from " +
      "`transcribe.speakers` on the angle's sound: its mic's file, else its own) whose words are this person's turns when people share " +
      "a file or mic (null clears it). The angle id stays, so shots keep showing it. " +
      "Example: `{ group: \"g_1a2b3c\", angle: \"ben\", crop: { left: 0.1, right: 0.1 }, gain: -3 }`. Sync is `multicam.offset`. " +
      "Fails with InvalidOperation when the group, angle or mic does not exist, nothing is given, gain or muted is given for an angle that takes its sound from a mic or none, or the crop would leave no picture " +
      "(left + right, top + bottom must stay below 1).",
    params: operationArgs["multicam.angle"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.reframe": {
    mutating: true,
    description:
      "Reframe one angle of a multicam group over time: set or remove a key of its `reframe`, the point of its picture (`x`, `y`: " +
      "fractions of the source width and height) that a tile cutting the picture to its aspect centers on. This is how a 9:16 export " +
      "(`vertical-1080x1920`) of 16:9 cameras keeps each face in its solo and two-up shots. Keys live in the group, on the group clock, " +
      "so every shot of that angle follows them and ripple cuts keep them on the same picture; between keys the point moves in a " +
      "straight line, before the first and after the last it holds. Give the key time as `at` (group seconds) or `time` (timeline " +
      "seconds, mapped through the program track's shot playing then). A key in the same frame is replaced; an omitted `x` or `y` " +
      "keeps the point there now. `remove: true` deletes the key in that frame, `clear: true` every key, `keys` replaces them " +
      "all at once (`multicam.faces` proposes them from faces). A 16:9 frame of 16:9 " +
      "cameras is not cut, so keys change nothing there; screens are never cut. " +
      "Example: `{ group: \"g_1a2b3c\", angle: \"ana\", time: 12.5, x: 0.32 }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, neither or both of `at` and `time` are given, no shot of " +
      "the group plays at `time`, nothing is given to set, or `remove` finds no key in that frame.",
    params: operationArgs["multicam.reframe"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.faces": {
    mutating: true,
    description:
      "Propose `reframe` keys for the angles of a multicam group from the faces in their pictures (ADR 0016), so a 9:16 export " +
      "(`vertical-1080x1920`) of 16:9 cameras keeps each person in frame. Looks at 2 frames per second of each angle's file " +
      "(locally, on CPU: the YuNet face detector run by ONNX Runtime; the first run downloads both, about 33 MB, from their " +
      "builders), follows the largest face inside the angle's crop, and writes keys only where it moves: one key per still " +
      "stretch, a quick glide between them. One `multicam.reframe` operation per angle (with `keys`), all in one transaction, " +
      "so one revert undoes the lot; the person corrects keys in the app or with `multicam.reframe` as usual. Angles that " +
      "already have keys are skipped (`kept`) unless `replace: true`; screens are never looked at. An angle where no face is " +
      "found is left as it was, with a warning. Takes a while on long recordings (progress arrives as `progress` " +
      "notifications). It runs as a background job of kind `faces` (`job.list`), so it goes on if the caller disconnects. Example: `{ group: \"g_1a2b3c\", angles: [\"ana\"] }`. Fails with InvalidOperation (group or angle " +
      "missing, an angle named that is a screen), TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg, ONNX " +
      "Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
      angles: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Angle ids to look at. Default: every angle of the group that is not a screen."),
      replace: z.boolean().optional().describe("Also redo angles that already have reframe keys, replacing them. Default false."),
    }),
    result: MulticamFacesResultSchema,
  },
  "clip.reframe": {
    mutating: true,
    description:
      "Frame one video clip for another aspect, vertical (`9x16`) by default, keeping a face in it (epic #451, reels). The picture is " +
      "scaled to cover the frame (`transform.scale`) and positioned so the face center sits at the middle and 30 % from the top, " +
      "never showing outside the picture. Without `person` or `anchor` it looks at 2 frames per second of the clip's own stretch " +
      "of its file (locally, on CPU: YuNet face detection; the first run downloads it, about 33 MB), follows the largest face, " +
      "and writes `x`/`y` keys only where the face moves: a still stretch holds, a move glides with ease in-out; a face that never " +
      "moves gives a static `transform` and no keys. `person` (id or name) follows that person's face from the cached face scan " +
      "(`people scan`, with the person's face linked) instead, with no detection. `anchor` (0 to 1) skips faces: a fixed " +
      "horizontal position of the picture (0 left edge, 1 right edge) in the middle of the frame, for footage with no face. " +
      "Rotation metadata is applied to the picture first. One transaction labelled `Reframe <file name>` (yours when one is open): " +
      "`revert` undoes it, the person edits the keys in the inspector or with `clip.key`, and in review mode it is one proposal. " +
      "It replaces the clip's `x`, `y` and `scale` (static and keys; a warning says so) and leaves its other fields. When " +
      "`format` is the id of a format of the project other than the primary (`format.list`, ADR 0027), the framing goes into " +
      "the clip's override there (`formats.<id>`, as `clip.set`/`clip.key` with `format` write it; `inFormat` in the result) " +
      "and the clip itself, the primary and every other format keep theirs, so each format can follow the face its own way. " +
      "Otherwise `format` is an aspect and the framing goes into the clip, for every format: with a project of another " +
      "aspect the preview shows the project frame zoomed; a warning says so. `9:16` always means the aspect. For landscape footage with no face, look at a frame " +
      "(`frame.capture`) and pick `anchor`. A clip with no face found is left as it was, with a warning. Runs as a background " +
      "job of kind `faces` (`job.list`) with `progress` notifications. " +
      "Example: `{ clip: \"c_0003\", format: \"9x16\" }`. Fails with InvalidOperation (not a media clip on a video track, " +
      "no moving picture to look at, bad `format`, `person` and `anchor` together, `person` unknown or its file not scanned), " +
      "ClipNotFound, TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg, ONNX Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Id of a media clip on a video track, from `timeline.show`."),
      format: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A format id of the project (`format.list`; one other than the primary takes the framing in its override), else the aspect " +
            "of the frame, `<w>x<h>` or `<w>:<h>`: `9x16` (default), `1x1`, `4x5`, `16x9`…",
        ),
      person: z.string().min(1).optional().describe("Follow this person's face (id or exact name from `people.list`) from the cached scan of the clip's file."),
      anchor: z.number().min(0).max(1).optional().describe("Fixed horizontal position of the picture in the frame, 0 (left edge) to 1 (right edge); no face detection."),
    }),
    result: ClipReframeResultSchema,
  },
  "segment.prepare": {
    description:
      "Get a still image ready to be pointed into (ADR 0022, photo segmentation): encodes it once with MobileSAM and keeps the " +
      "result in memory by content hash (the last 8 photos), so the first click costs about 0.2 s instead of 3 s. Called by the " +
      "app when Pick turns on in an image project; `inspect.point` prepares on demand, so agents never call it. The first run " +
      "downloads the model (two files, about 45 MB) and ONNX Runtime Web (33 MB, if face detection never ran). " +
      "Fails with AssetNotFound, OutsideProject, InvalidOperation (not an image project, not a still image), or the Binary* errors.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Still image, absolute or relative to `cwd`."),
    }),
    result: z.object({
      asset: z.string().describe("Project-relative asset path."),
      size: z.object({ width: z.int(), height: z.int() }).describe("The image's pixels, rotation applied."),
      hash: z.string().describe("`sha256:<hex>` of the asset's content, the key of the cached embedding."),
      model: z.string().describe("Pinned model, `mobilesam@<revision>`."),
      cached: z.boolean().describe("True when the image was prepared already."),
    }),
  },
  "matte.prepare": {
    description:
      "Compute the subject matte of a video asset (ADR 0032): which pixels of each frame are the person in front, so text " +
      "or graphics can later sit behind them. Locally on CPU: MediaPipe's selfie segmenter (Apache-2.0; the first run " +
      "downloads 0.5 MB, plus ONNX Runtime Web, 33 MB, if face detection never ran) on every frame of the asset's proxy, " +
      "smoothed over time and snapped to the picture's edges. The whole asset is matted once per content: the result is a " +
      "grayscale video at proxy size (white = subject, black = background, same frames as the proxy) cached in " +
      "`.frameshell/cache/mattes/` (regenerable, swept by `gc`); a later call returns it at once (`cached: true`). " +
      "Waits for the asset's ingest when its proxy is not built yet. Takes an estimated 1.5 minutes per minute of 30 fps video " +
      "on an Apple M3 (`progress` notifications carry an ETA). It runs as a background job of kind `matte` (`job.list`), so " +
      "it goes on if the caller disconnects. Known limits: one merged matte for two or more people; thin hair strands " +
      "and mic stands are often left out. Export and frame captures use it for tracks `behind` a plate (`track.set`) and make " +
      "it when missing; calling this first lets them start at once. " +
      "Example: `{ asset: \"assets/interview.mp4\" }`. Fails with AssetNotFound, OutsideProject, InvalidOperation " +
      "(reason `not a video`: audio or a still picture; `image project`; `ingest failed`), or the Binary* errors when ffmpeg, " +
      "ONNX Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Video asset, absolute or relative to `cwd`, e.g. `assets/interview.mp4`."),
    }),
    result: z.object({
      asset: z.string().describe("Project-relative asset path."),
      hash: z.string().describe("`sha256:<hex>` of the asset's content, part of the cache key."),
      model: z.string().describe("Model that made it: `mediapipe-selfie@<revision>`, or `stand-in` in tests."),
      matte: z
        .string()
        .describe(
          "Project-relative matte video, `.frameshell/cache/mattes/<key>.mp4`: H.264, luma = matte (full range, 0 " +
            "background to 255 subject, chroma neutral), frame N = proxy frame N.",
        ),
      size: z.object({ width: z.int(), height: z.int() }).describe("Matte pixels: the proxy's size (short side at most 540)."),
      fps: z.number().describe("Frames per second: the project fps, as the proxy."),
      frames: z.int().describe("Frames in the matte."),
      cached: z.boolean().describe("True when the matte of this content existed already and nothing was computed."),
      seconds: z.number().describe("Seconds it took to compute (when it was computed, for a cached one)."),
    }),
  },
  "beats.measure": {
    mutating: true,
    description:
      "Measure the beat grid of a music asset (ADR 0029) and write `beats/<asset minus extension>.beats.json` " +
      "(`beats/<asset>.beats.json`, extension kept, when another asset with the same base name owns the first name): the " +
      "tempo, every beat in source-asset seconds, which beat starts a bar, the strong hits (onsets), a confidence and the " +
      "largest gap between the straight grid and a hit it matched (`residualMs`, under 15 on a clean track). Locally, no " +
      "download: an onset envelope (spectral flux) of the asset's PCM sidecar, a tempo from its autocorrelation, one straight " +
      "period fitted through the hits, each beat snapped to a hit within 8 ms, the bar start taken from the low band. " +
      "The grid stands where there is rhythm (from the first matched hit to the last). Calm or sparse music gets a double-time " +
      "grid: that shows as `low: true` (confidence under 0.5); `alternatives` then lists the other tempi, best supported first, and " +
      "you or the person pick one with `edits.tempo` (`double` or `half`) in the file; a low grid is never snapped to. " +
      "Pass `bpm` when you know the tempo: the grid is the octave nearest to it (a 60 BPM song stays 60, not 120). " +
      "Audio comes from the asset's PCM sidecar; without a finished ingest the asset is decoded at 16 kHz and the result is " +
      "capped at low confidence. Human `edits` (tempo, downbeat, offset; see `beats.show`) are kept across a new " +
      "measure unless `resetEdits` or the asset content changed since. Runs as a background job of kind `beats` (`job.list`) in a worker thread; the onset " +
      "envelope is cached by content in `.frameshell/beats/` (swept by `gc`), so measuring again with another `bpm` takes " +
      "about a second; a 3-minute track takes about 5 seconds the first time. Not for speech or long recordings: tracks over 10 " +
      "minutes are refused. Example: `{ asset: \"assets/music/theme.mp3\", bpm: 120 }`. Fails with AssetNotFound, " +
      "OutsideProject, InvalidOperation (reason `no audio`, `too long`, `no beats`: silence or no rhythm, or `name taken`), " +
      "InvalidProjectFile (the existing beats file is broken: fix or delete it), or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Music file inside the project, absolute or relative to `cwd`, e.g. `assets/music/theme.mp3`."),
      bpm: z.number().min(20).max(400).optional().describe("Tempo you expect, in BPM; the measured tempo is moved by octaves toward it. Default: the detector's choice, 70-170 BPM."),
      resetEdits: z.boolean().default(false).describe("Drop the human `edits` of the previous file instead of keeping them. Default false."),
    }),
    result: BeatsSummarySchema.extend({
      cached: z.boolean().describe("True when the cached onset envelope was reused and only the grid was worked out again."),
      keptEdits: z.boolean().describe("True when human `edits` of the previous file were carried over (they are dropped when the asset content changed since)."),
      seconds: z.number().describe("Seconds it took."),
    }),
  },
  "beats.show": {
    description:
      "The beat grid of a music asset (ADR 0029): what `beats.measure` wrote to `beats/<asset>.beats.json`, with the human " +
      "`edits` applied, in source-asset seconds. `beats` are the beat times, `downbeats` the ones that start a bar; the `edits` " +
      "(`tempo`: `double` or `half`, `downbeat`: index of the first bar start, `offset`: seconds) are in the file, which you " +
      "change with `file.write` (the content is validated). `low` means the grid may be double time or a bar off: look at " +
      "`alternatives`, tell the person, and do not cut to it without their say. `current: false` means the asset changed " +
      "since: measure again. Pure read; no audio is analysed. Example: `{ asset: \"assets/music/theme.mp3\" }`. " +
      "Fails with AssetNotFound, OutsideProject, InvalidOperation (reason `not measured`: run `beats.measure`), InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Music file inside the project, absolute or relative to `cwd`."),
    }),
    result: BeatsSummarySchema.extend({
      current: z.boolean().describe("True when the asset's content is the one that was measured."),
      edits: BeatsEditsSchema.describe("Human corrections in the file; empty when none."),
      beats: z.array(z.number()).describe("Beat times in source-asset seconds, `edits` applied, increasing."),
      downbeats: z.array(z.number()).describe("The beats that start a bar, source-asset seconds."),
    }),
  },
  "image.cutout": {
    mutating: true,
    description:
      "Cut a part out of a photo as a new layer (ADR 0022). `clip` is a still media clip of an image project; `mask` is a " +
      "project-relative 8-bit grayscale PNG at the photo's own pixel size, white (255) where the part is: the `mask` of a point's " +
      "`segment.masks` from `inspect.point`, or one you made. The photo with the mask as its transparency, cropped to the mask's " +
      "box, is written as a new file `assets/<photo name>-cutout-<n>.png` (the photo itself is never changed) and placed on a new " +
      "video track right above the photo's: same start, length and opacity, position and scale set so the part covers its own " +
      "pixels of the photo. One transaction labelled `Cut out <photo name>` (yours when one is open): reverting removes the " +
      "layer; the PNG stays in `assets/`. Background removal is this followed by `clip.set` `opacity: 0` on the photo (or " +
      "`clip.remove`). Keyframes and fades of the photo are not copied (a warning says so). " +
      "Example: `{ clip: \"c_0003\", mask: \".frameshell/context/m_0_1210_1530_3.png\" }`. Fails with InvalidOperation (video " +
      "project, not a still media clip, mask not a grayscale PNG of the photo's size, empty mask), ClipNotFound, AssetNotFound, " +
      "OutsideProject, or the Binary* errors.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Id of the photo's clip, from `timeline.show`."),
      mask: z.string().min(1).describe("Grayscale PNG at the photo's size, project-relative or absolute inside the project; white = keep."),
    }),
    result: OperationResultSchema.extend({
      asset: z.string().describe("Project-relative path of the new PNG with transparency."),
      track: z.string().describe("Id of the new track, right above the photo's."),
      clip: z.string().describe("Id of the new clip on it."),
    }),
  },
  "multicam.paint": {
    mutating: true,
    description:
      "Correct who speaks in a multicam group by hand (ADR 0016 decision 3: a manual correction always overrides the measured " +
      "turns). Marks a range of the group clock as spoken (`speaking: true`) or silent (`speaking: false`) for one angle, or takes " +
      "it back to the measured turns (`speaking: null`; with `angle` left out, for every angle). The marks live in the group " +
      "(`painted`) and replace the angle's measured turns inside their range, for `multicam.turns` and `multicam.direct`, so " +
      "re-directing keeps them; undo reverts them like any operation. `alone: true` with `speaking: true` also marks every other " +
      "angle that can speak as silent in the range: the person takes the floor. A mark overlapping an earlier one of the " +
      "angle replaces it where they overlap; touching marks of the same kind merge. Screen angles are never speakers, so they " +
      "cannot be marked as speaking. Example: `{ group: \"g_1a2b3c\", angle: \"ana\", start: 12, end: 15.5, speaking: true, alone: true }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, `end` is not after `start`, `angle` is missing with " +
      "`speaking` set, `alone` is used without `speaking: true`, or a screen angle is marked as speaking.",
    params: operationArgs["multicam.paint"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "shot.set": {
    mutating: true,
    description:
      "Change a shot of a program track (ADR 0016): its layout `shot` (`solo` 1 angle, `two-up` 2, `grid` 2 or more, `screen` 1 " +
      "angle whole with bars, never cropped, `pip` 2: the screen first, then a speaker as an inset in `corner`) and/or the " +
      "`angles` it shows, in layout order. Only `shot`: the angles are kept, cut to the layout's count, or filled with the group's " +
      "next angles in group order (`screen` and `pip` put angles marked `screen` first). Only `angles`: the layout stays when it " +
      "takes that many, else it follows the count (1 `solo`, 2 `two-up`, more `grid`). Both: they must fit. `corner` " +
      "(`top-left`, `top-right`, `bottom-left`, `bottom-right`; default `bottom-right`) only fits a `pip` shot. " +
      "The shot becomes one a person chose: `confidence` and `reason` are removed. " +
      "Timing does not change: split the shot first (`clip.split`) to change only part of it. Examples: " +
      "`{ clip: \"c_0301\", shot: \"solo\", angles: [\"ana\"] }`, `{ clip: \"c_0301\", shot: \"pip\", angles: [\"screen\", \"ana\"], corner: \"top-right\" }`. " +
      "Fails with InvalidOperation (not a shot, unknown or repeated angle, angle without a picture, wrong count for the layout).",
    params: operationArgs["shot.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.turns": {
    description:
      "Who speaks when in a multicam group (ADR 0016): the speaking turns of every angle, from the energy of the angle's sound " +
      "(its `mic` of the group's `mics`, with the mic's offset and gain, else its own file; the cached envelopes cut snapping uses), " +
      "on the group clock (each angle's `offset` applied). Example: " +
      "`{ group: \"g_1a2b3c\" }` gives `turns: [{ angle: \"ana\", name: \"Ana\", start: 0.4, end: 5.2 }, …]` sorted by `start`. " +
      "A voice heard in another person's mic (bleed, more than 12 dB below the loudest mic at that time) does not count as " +
      "that person's turn; people talking at once keep overlapping turns. Pauses under 0.5 s stay inside a turn, sounds under " +
      "0.3 s are not turns. Read-only. Each angle's `audio.gain` (dB) is added to its mic level before mics are compared. An angle without sound has no turns and a " +
      "warning (`mic: null`: no warning); screen angles are never speakers. Shared sound: angles that hear the same file, angles that hear the same mic once its transcript has speakers (else they " +
      "speak together: two cameras of one person), and angles with a `speaker`, take their turns from the " +
      "words of that speaker in that sound's transcript (`transcribe.speakers` first; corrections in `edits` count); an angle " +
      "of a shared sound with no `speaker` takes the first speaker no other angle names, in order, and a warning says so " +
      "(set it with `multicam.angle`). `speakers` lists the angles measured that way. Stretches a person painted " +
      "(`multicam.paint`, `painted` in the group) replace the measured turns of their angle inside their range. Fails with InvalidOperation (group does not exist; data lists the groups), TimelineNotFound, AssetNotFound, " +
      "or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
    }),
    result: MulticamTurnsResultSchema,
  },
  "multicam.direct": {
    mutating: true,
    description:
      "Direct a multicam group (ADR 0016): turn its speaking turns (`multicam.turns`, measured here) into shots on its program " +
      "track by rules, in one operation. Deterministic: the same turns and rules give the same shots. Rules: the `template` " +
      "(`interview` default, `podcast-calm`, `panel-dynamic`) with `director.json` in the project (or `rules`) on top: shortest " +
      "and longest solo, two-up on quick exchanges and on two people talking at once, wide (`grid`) on silence and laughter, cut " +
      "lead (the voice leads the cut, J-cut), weight per angle. Angles marked `screen` (`multicam.angle`) are measured for motion " +
      "(the picture changing): a stretch of motion becomes a `screen` shot while nobody speaks and a `pip` (screen with the " +
      "speaker as an inset) while someone does; screens never speak. The program track keeps what plays where: each shot in range is " +
      "replaced by directed shots over the same group time, gaps stay gaps; an empty track is filled over the whole group. " +
      "Shots a person chose in the app (`shot.set` by author `ui`, and pieces cut out of them) are kept unless " +
      "`replaceHuman: true`; `kept` lists those in the range. Every shot gets " +
      "`confidence` and `reason`; `low` lists those below 0.5 to review (e.g. a reaction worth holding), then fix them with " +
      "`shot.set`. `operation.args.turns` is the number of turns used (the journal keeps them all). " +
      "Example: `{ group: \"g_1a2b3c\", template: \"podcast-calm\", from: 60, to: 120 }`. Fails with " +
      "InvalidOperation (group or program track missing, invalid rules file, nothing to direct in the range: data says why), " +
      "TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
      template: z
        .enum(DIRECTOR_TEMPLATE_IDS)
        .optional()
        .describe("Rule set to start from; replaces the rules file's `template`. Default: the file's, else `interview`."),
      rules: z
        .string()
        .min(1)
        .optional()
        .describe("Rules file inside the project, absolute or relative to `cwd`. Default `director.json` at the project root, when it exists."),
      from: z.number().nonnegative().optional().describe("Timeline seconds where directing starts. Default 0."),
      to: z.number().nonnegative().optional().describe("Timeline seconds where it ends. Default: the end of the program track."),
      replaceHuman: z.boolean().optional().describe("Also replace shots a person chose in the app. Default false."),
    }),
    result: MulticamDirectResultSchema,
  },
  "captions.set": {
    mutating: true,
    description:
      "Write hand-chunked captions with chosen keywords on a subtitle track. `text` (or a project file, `file`) holds one phrase per " +
      "line: chunks (one cue each) separated by `|`, the phrase's ONE emphasised word between asterisks, e.g. " +
      "`No need to | open any | *editor*`; an optional `[chars]`, `[words]`, `[line]` or `[none]` at the start of a line sets that " +
      "phrase's entry; blank lines and `#` lines are skipped. The text covers every word the track shows between `from` and `to` " +
      "(timeline seconds, default the whole track), in order: the words are matched by position, so a text that loses or repeats a " +
      "word fails (the error names the first difference); typed words that differ from the transcript after case, accents and " +
      "punctuation only warn. Mapped onto transcript word ids, so cuts and transcript corrections keep the phrases (a word a cut " +
      "removed just leaves its chunk). Words no phrase holds keep the style's automatic grouping. A chunk lasts until the next cue " +
      "starts, at most 0.35 s past its last word and never under 0.4 s. The keyword takes the style's `keywordColor` " +
      "(`track.set` `style`; default the preset's accent) and, with an `entry`, settles from `keywordScale`. Phrases that share a " +
      "word with the new ones are replaced; `replace: true` drops all the track's other phrases first, and with no text clears them. " +
      "`cues` lists what the range shows now. Example: `{ track: \"t_4d5e6f\", text: \"No need to | open any | *editor*\", from: 12, to: 15 }`. " +
      "Fails with TrackNotFound or InvalidOperation (not a subtitle track, no text, a second keyword in a phrase, an empty chunk, a " +
      "phrase across two assets, word counts that differ).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      track: z.string().min(1).describe("Subtitle track id from `track.list`, e.g. `t_4d5e6f`."),
      text: z.string().optional().describe("The captions, one phrase per line. Give this or `file`; neither with `replace: true` clears the phrases."),
      file: z.string().min(1).optional().describe("Text file inside the project with the same format, absolute or relative to `cwd`."),
      from: z.number().nonnegative().optional().describe("Timeline seconds where the captioned range starts: words from this frame on. Default 0."),
      to: z.number().nonnegative().optional().describe("Timeline seconds where it ends: words that start before this frame. Default: the end of the track's words."),
      replace: z.boolean().optional().describe("Also drop every other phrase of the track. Default false."),
    }),
    result: CaptionsSetResultSchema,
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
      "`changes.added`. The left part keeps the clip's dissolve and fade in, the right part its fade out, the new cut has none; both keep every keyframe. Example: `{ clip: \"c_1a2b3c\", at: 7.5 }`.",
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
      "Change clip properties: `speed` (media; end moves), `gain` (dB), `muted`, `audioFadeInMs`/`audioFadeOutMs` (media; sample-accurate " +
      "equal-power sound ramps at the clip's edges in ms, e.g. 12 to de-click a cut, 0 removes; a split drops them at the new cut), " +
      "`audioEffects` (media; replaces the effect list, " +
      "`null` clears; see below), `backdrop` (generated clips; see below), `transform` (merged field by field), " +
      "`props` (adapter clips; replaced), `elements` (adapter clips whose plugin supports it: move or scale an element inside a generated " +
      "clip by CSS selector, e.g. `{ \"#title\": { y: -40, scale: 1.2 } }`; merged per selector, `null` for a selector removes it, `null` for " +
      "the field clears all; the composition file stays untouched), `scriptRef` (script scene `ref` from `script.outline`, or the script path " +
      "alone for the whole script; null clears). A `scriptRef` whose script or scene does not exist is still stored, with a `warnings` entry naming the scenes " +
      "there are; a `scriptRef` path that is absolute or uses `..` fails with InvalidOperation. " +
      "`audioEffects` (ADR 0031) process the clip's sound in order before gain and fades: the voice chain is " +
      "`[{ kind: \"highpass\", frequency: 85 }, { kind: \"denoise\", floor: -30, reduction: 8 }, { kind: \"compressor\", threshold: -20, ratio: 2.5, " +
      "attack: 8, release: 140, makeup: 2 }]`. The asset is baked once per chain in the background; export waits for it, the preview plays " +
      "dry until it is ready. Energy snapping and transcription keep the dry sound. Integrated loudness stays the export's (`export.loudness`). " +
      "`backdrop` (ADR 0031) makes a generated clip glass: export and preview blur (`blur`, Gaussian sigma in project px), saturate " +
      "(`saturate`, 1 unchanged) and dim (`dim`, 0 to 1) the picture below the clip wherever the clip's alpha shows, then draw the clip; " +
      "its render does not change. Merged field by field, `null` clears. Glass is a style choice, never a default: use it when the " +
      "style's `glass.cards` is true, with the style's `glass` numbers (`style_show`), else only when asked. On the bottom video track " +
      "nothing is below: stored with a warning, not drawn. " +
      "`motionBlur` (ADR 0041, generated clips) renders each frame as the average of `samples` (default 8) pictures across a shutter of " +
      "`shutter` degrees (default 180, centred on the frame), averaged in `blend` space (default `linear`): fast moves smear like a camera's. " +
      "`{}` turns it on with the defaults, merged field by field, `null` clears. The clip re-renders and the render costs about `samples` " +
      "times a sharp one; preview and export wait for it. Use it on fast motion graphics, not on text that should read sharp while it " +
      "moves. A composition that cuts between scenes inside itself declares the cut with the motion runtime's `cuts()`, else the frame " +
      "at the cut blends both scenes. " +
      "`format` (ADR 0027, a format of `format.list` other than the primary) sets the clip in that format only, stored in its " +
      "`formats` override: `transform`, `props` (checked over the clip's own), `elements` and `hidden` (no picture there, the sound " +
      "still plays); `reset: true` drops the override first. Use it where the automatic layout of a format is wrong, e.g. a lower " +
      "third that sits too low in 9:16: `{ clip, format: \"9x16\", transform: { y: 520 } }`. Timing and sound are every format's: " +
      "with `format`, speed, gain, muted, audio fades, audioEffects, backdrop, motionBlur and scriptRef are refused. Check it with `frame` and `projectFormat`. " +
      "Example: `{ clip: \"c_1a2b3c\", gain: -6 }`.",
    params: operationArgs["clip.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "transition.set": {
    mutating: true,
    description:
      "Put a transition on a clip edge (ADR 0018, ADR 0030). Only `at` is needed: `{ at: 12.5 }` dissolves into the clip starting at " +
      "12.5 s on every video and audio track that has an edge there (sound crossfades), 0.5 s long. `kind: \"fade\"` dips through black " +
      "instead (transparent on upper tracks, silence for sound). `kind: \"wipe\"` (a straight edge uncovers the incoming clip) and " +
      "`kind: \"push\"` (the incoming clip slides in and pushes the outgoing one out) move the picture instead of mixing it; `direction` " +
      "`left` (default), `right`, `up` or `down` is the way the incoming picture travels: `{ at: 12.5, kind: \"push\", direction: \"up\" }`. " +
      "`kind: \"iris\"` opens the incoming clip in a circle growing from the centre of `origin`, `[x0, y0, x1, y1]` in fractions of the " +
      "frame (the element that just lit up, from `inspect.point`; default the frame's centre): `{ at: 12.5, kind: \"iris\", origin: [0.6, 0.2, 0.8, 0.4] }`. " +
      "`kind: \"zoom\"` dives the outgoing clip into the centre of `origin` (up to 4 times larger, by the size of `origin`: its larger side " +
      "fills the frame; default the middle half) while the incoming clip grows out of that point, so use it where the eye is on one element " +
      "and the next shot is about it. `kind: \"slats\"` uncovers the incoming clip in `count` strips at once (default 8, 2 to 64), each the " +
      "`direction` way, on a rhythm beat. `kind: \"grid\"` shows it in square cells switching on in a scattered order, `count` across " +
      "(default 12), to end a section on a grid image. " +
      "They play on every video track with an edge there, like a dissolve: on an upper track the outgoing clip shows only where the " +
      "incoming one does not (the shape cuts both, keeping a render's own alpha), so a title can wipe or push off over the picture below. " +
      "At an edge of a nested timeline clip the shape plays on its clips too, its upper tracks included. Audio tracks crossfade. " +
      "`kind: \"dip-cut\"` makes the edge a hard cut on the bottom " +
      "video track and darkens the clip ending there by 40 % over its last 3 frames, as `opacity` keys on it (`duration` is ignored; " +
      "sound and other tracks are not touched; another video track named in `tracks` is refused); `transition.remove` there takes the " +
      "dip keys away again. Pick the kind by why the picture changes (see the skill's transitions reference); " +
      "a `warnings` entry flags three transitions of one kind in a row, or more than a third hard cuts, on the bottom track. " +
      "`duration` is the total seconds; `tracks` limits it. The clips stay where they are and the timeline length never changes: a " +
      "transition is centered on the cut and borrows source from before the incoming clip's `in` and after the outgoing clip's `out`. " +
      "An edge with no clip butted to it (a clip's start or end) fades in or out for any kind: `{ at: 58, kind: \"fade\", duration: 1 }` " +
      "fades the last clip out. Replaces any transition already on that edge. Multicam program tracks are skipped with a warning (hard " +
      "cuts). Short material never fails: it shortens the transition, or plays a dissolve with no spare source as a dip, and a `warnings` " +
      "entry says so; a shape with no spare source holds the outgoing clip's last frame or the incoming clip's first instead. " +
      "Fails with InvalidOperation when no targeted track has a clip edge at `at` (the message lists the edges), `direction` comes " +
      "with another kind than `wipe`, `push` or `slats`, `origin` with another kind than `iris` or `zoom`, `count` with another kind than " +
      "`slats` or `grid`, or a dip cut finds no clip ending at `at` on " +
      "the bottom video track; TrackNotFound.",
    params: operationArgs["transition.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "transition.remove": {
    mutating: true,
    description:
      "Clear the transition on the clip edge at `at` (dissolve and its shape, fade in, fade out, a dip cut's keys on the clip ending " +
      "there) on every video and audio track that has one, or only `tracks`. Example: `{ at: 12.5 }`. The clips stay where they are. Fails with InvalidOperation when no targeted track has a " +
      "clip edge at `at`; an edge without a transition adds a warning.",
    params: operationArgs["transition.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.key": {
    mutating: true,
    description:
      "Animate a clip property over time with keyframes (ADR 0018). `prop`: `x`, `y` (project pixels), `scale`, `opacity` (0 to 1) or " +
      "`gain` (dB; the only one audio tracks take). `time` is timeline seconds inside the clip, snapped to the frame; the key is added " +
      "or replaced there, `value` defaults to what plays there now. Between keys the value moves linearly or by the leaving key's " +
      "`ease` (`in`, `out`, `in-out`); before the first key and after the last it holds. A keyed property ignores its static " +
      "value (`clip.set`). `remove: true` deletes the key at `time`; `clear: true` deletes every key of `prop`. Keys stay on the same " +
      "frames of the clip's picture through trim, split and cut. Example, a slow zoom over a clip at 10 to 20 s: " +
      "`{ clip, prop: \"scale\", time: 10, value: 1 }` then `{ clip, prop: \"scale\", time: 20, value: 1.2 }`. " +
      "`format` (ADR 0027) keys `x`, `y`, `scale` or `opacity` in that format only (its first key there starts from the clip's own " +
      "keys of `prop`); `clear` with `format` drops that format's keys of `prop`, so it follows the clip's own keys there " +
      "again (unless that format's `transform` sets `prop`). Fails with " +
      "InvalidOperation (time outside the clip, no key to remove, audio track with a picture property, shots, `gain` with `format`, the primary format) or FormatNotFound.",
    params: operationArgs["clip.key"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.duck": {
    mutating: true,
    description:
      "Duck music under speech: write gain keys (ADR 0018, `clip.key` `gain`) on the clips of the audio track `track` so they dip " +
      "while someone speaks on the `under` tracks. Speech is found from the energy of the `under` tracks' sound (muted clips and " +
      "tracks are ignored): a stretch is where it stays above `threshold`, stretches closer than `gap` merge. Each stretch " +
      "gets a dip of `depth` dB that is complete when the voice starts (`attackMs` before) and lets go `releaseMs` after it ends, " +
      "straight lines in between. The keys are the clip's level (its `audio.gain`, or its own keys) minus the dip, with a key at the " +
      "clip's start and end so the lane never holds a dip by accident. They are marked `auto: \"duck\"`: running it again replaces " +
      "those and keeps the keys you set by hand; clips with no speech over them lose their old ones. The person sees and edits the " +
      "curve in the clip; preview and export play it like any gain key. One operation, one revert. Voice in nested timeline clips " +
      "is not heard (a warning says so), nor are multicam angles and mics: a program track in `under` is refused. A voice file " +
      "that cannot be decoded is named in the warnings. A hand key where someone speaks is dipped too and its level comes back on the next run. " +
      "`level` first sets each clip's static gain (`audio.gain`) so the music's integrated loudness (EBU R128, measured once per file and cached) " +
      "sits `level` dB under the voice's: the voice is every clip of the `under` tracks, its file's loudness plus its gain, averaged by the time it plays " +
      "(about 12 dB under is a start; the style's `sound.musicUnderVoice`); a clip with gain keys of its own is left alone and named in the warnings. " +
      "The depth, attack, release, threshold, gap and `level` are kept in `audio.duck` of each clip that gets duck keys, so `music.fit` runs the same duck again after it moves one. " +
      "Example: `{ track: \"t_music\", under: [\"t_voice\"], depth: 8, level: 12 }`. Fails with InvalidOperation (`track` is not an audio " +
      "track, `under` names it or a program track), TrackNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      track: operationArgs["track.duck"].shape.track,
      under: z.array(z.string().min(1).describe("Track id from `track.list`.")).min(1).describe("Video or audio tracks whose speech the music ducks under."),
      depth: z.number().positive().max(60).default(7).describe("dB the clips dip below their level while someone speaks. Default 7."),
      attackMs: z.number().min(1).max(5000).default(40).describe("Milliseconds the dip takes to reach full depth, ending as the voice starts. Default 40."),
      releaseMs: z.number().min(1).max(10000).default(450).describe("Milliseconds the level takes to come back after the voice stops. Default 450."),
      threshold: z.number().min(-90).max(0).default(-38).describe("dBFS above which sound counts as speech. Default -38."),
      gap: z.number().min(0).max(30).default(0.6).describe("Seconds: speech stretches closer than this merge, so the music does not pump between words. Default 0.6."),
      level: z
        .number()
        .min(0)
        .max(40)
        .optional()
        .describe("dB the music's integrated loudness sits under the voice's: sets the static gain of each clip of `track` first. Default: the gains stay as they are."),
    }),
    result: TrackDuckResultSchema,
  },
  cut: {
    mutating: true,
    description:
      "Remove the timeline range [from, to) and close the gap (ripple): clips inside are removed, clips crossing an edge " +
      "are trimmed or split, later clips move left by `to - from`. Applies to every video, audio and program track unless " +
      "`tracks` is given (cutting only some tracks shifts them against the rest). Example: `{ from: 12.4, to: 13.1 }` " +
      "removes a 0.7 s silence. Where media clips with audio (or a program track's angles) lie under an edge, it snaps into the nearest audio pause " +
      "within ±`snapWindow` (default: project `editing.snapWindow`, else 0.5 s) so no word is clipped; `snaps` reports requested vs applied and " +
      "`clean: false` when no pause was in reach (speech may be clipped there). `snap: false` cuts exactly. " +
      "A cut that trims or splits an adapter clip (e.g. `hyperframes`) adds a `warnings` entry naming its id, type and `scriptRef`: edit audio before building visuals.",
    params: operationArgs.cut.extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.list": {
    description:
      "List a timeline's markers (ADR 0029): named points on the timeline clock, each with id (`m_…`), timeline second `at`, " +
      "label and optional colour, sorted by `at`. Markers paint nothing and play nothing; they name moments (a hook, a beat to land on) " +
      "for the person and the agent. `timeline.show` lists them too. In review mode, `view` picks the file or the open proposal's version. " +
      "Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: MarkerListResultSchema.extend(ViewedShape),
  },
  "marker.add": {
    mutating: true,
    description:
      "Add a marker: a named point on the timeline clock (ADR 0029), e.g. `{ at: 12.5, label: \"hook\" }`; `at` snaps to the frame grid. " +
      "Labels are unique in the timeline ignoring case, at most 80 characters, no space at either end, never shaped like an id " +
      "(`m_1a2b3c`) or a grid reference (`beat:8`, `bar:2`, any case). `color`: `red`, `orange`, `yellow`, `green`, `blue` or `purple`. `cut` moves markers after the cut with the " +
      "material and deletes markers strictly inside the removed range (a marker on the range's first frame stays; only when it cuts " +
      "every video, audio and program track, otherwise markers stay); `ripple` inserts and trims move them the same way, and a ripple " +
      "trim deletes markers inside the material it removes. The new id is in `changes.added`. Fails with InvalidOperation (label taken; " +
      "the message names the marker holding it).",
    params: operationArgs["marker.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.set": {
    mutating: true,
    description:
      "Move, rename or recolour a marker (ADR 0029): `{ marker: \"hook\", at: 14 }`, `{ marker: \"m_1a2b3c\", label: \"cta\" }`; " +
      "`color: null` clears its colour. `marker` is the id or the label (ignoring case). Fields left out keep their value. Fails with " +
      "InvalidOperation (no such marker, the message lists them; label taken; nothing to change).",
    params: operationArgs["marker.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.remove": {
    mutating: true,
    description:
      "Delete a marker (ADR 0029): `{ marker: \"hook\" }`, by id or label (ignoring case). Fails with InvalidOperation when there is no " +
      "such marker (the message lists them).",
    params: operationArgs["marker.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "tempo.show": {
    description:
      "The beat grid of a timeline (ADR 0029): its stored `tempo` and, on the timeline clock, every beat and bar start in timeline " +
      "seconds. The grid is the measured one in the beats file of the `tempo.clip` music clip (`beats.measure`), carried through the " +
      "clip's start, `in` and speed so it follows the music when it moves, or a nominal grid from `bpm`. `grid` is null with " +
      "`problem` when a clip has no beats file yet or the file is broken, and null with no `problem` when the timeline has no tempo. " +
      "`low` means the measured grid may be double time or a bar off: `snapTo` refuses it until `edits` in the beats file correct it. " +
      "In review mode, `view` picks the file or the open proposal's version. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int(),
      tempo: TempoSchema.nullable().describe("The stored `tempo`; null when the timeline has none."),
      grid: TempoGridSchema.nullable().describe("The grid on the timeline clock; null when there is none (see `problem`)."),
      problem: z.string().nullable().describe("Why a `tempo` has no grid yet; null otherwise."),
      ...ViewedShape,
    }),
  },
  "tempo.set": {
    mutating: true,
    description:
      "Set or clear the timeline's beat grid (ADR 0029): `{ clip }` follows the measured grid in the beats file of that music clip's " +
      "asset (run `beats.measure` first; moving or trimming the clip moves the grid), `{ bpm, offset?, meter? }` is a nominal grid " +
      "on the timeline clock for blocking a film before music exists (beat `i` at `offset + 60 i / bpm`, each frame rounded once), " +
      "`{ clip, bpm, offset? }` a nominal grid riding on a clip (`offset` in its source seconds), `{ clear: true }` removes it. " +
      "Replaces the whole tempo. The app draws bars stronger than beats, drags snap to them, and any time argument takes `snapTo: " +
      "\"beat\" | \"bar\" | \"marker\"`. Removing the `clip` clears the tempo with a warning. Fails with InvalidOperation (not a media clip " +
      "of a video or audio track, nothing to set).",
    params: operationArgs["tempo.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  cleanup: {
    mutating: true,
    description:
      "Propose, then make, the cuts that take dead air and false starts out of a talking head. It reads the words of the " +
      "transcripts of the unmuted media clips (and the sound of multicam program tracks) and the audio energy of their files, " +
      "and cuts like `cut` does (ripple on every video, audio and program track). `pauses` (seconds, default 0.4; `false` = " +
      "off): a gap between two kept words longer than that, confirmed by the audio being quiet there (whisper stretches words " +
      "over silence, so the edges come from the audio, not from the word times); the cut leaves `breath` seconds (default 0.1) " +
      "of silence on each side and lies on the frame grid. `retakes: true`: a phrase of 1 to 6 words said again right after " +
      "(a false start, a stop, a restart; spelling variants and a cut-off last word match) cuts the earlier attempt and " +
      "keeps the last. Only candidates with `confidence` of `minConfidence` or more (default 0.5) count. A cut is made only " +
      "where transcribed speech covers every instant of it, so it never removes b-roll or other material that is not part of " +
      "the speech; a word with `speechInside` is never cut around. `dryRun: true` changes nothing and returns the candidates: " +
      "show them as a table (kind, start, end, words, reason, confidence), ask, then call again with the same options (the " +
      "plan is made again from the timeline as it is) and `skip` the ids the person rejected (a retake covers the pauses around it: rejecting it brings them back as `p` candidates). Without `dryRun` the cuts are " +
      "one transaction labelled `Cleanup: …` (`revert` undoes it whole; with review mode on it is one proposal); a cut word " +
      "shows struck through in the transcript view and clicking it restores it. Example: `{ pauses: 0.5, retakes: true, " +
      "dryRun: true }`. Fails with InvalidOperation (`breath` too large for `pauses`, a `skip` id that is not a candidate, " +
      "no transcript for the speech) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      pauses: z
        .union([z.number().min(0.15).max(30), z.literal(false)])
        .default(CLEANUP_PAUSES_DEFAULT_S)
        .describe(`Shortest gap between two words, in seconds, to cut as a pause; \`false\` leaves pauses alone. Default ${CLEANUP_PAUSES_DEFAULT_S}.`),
      breath: z
        .number()
        .min(0)
        .max(2)
        .default(CLEANUP_BREATH_DEFAULT_S)
        .describe(`Seconds of silence left on each side of a cut. Default ${CLEANUP_BREATH_DEFAULT_S}; must be under half of \`pauses\`.`),
      retakes: z.boolean().default(false).describe("Also cut the earlier attempts of repeated phrases (false starts). Default false."),
      minConfidence: z
        .number()
        .min(0)
        .max(1)
        .default(CLEANUP_MIN_CONFIDENCE_DEFAULT)
        .describe(`Drop candidates below this confidence. Default ${CLEANUP_MIN_CONFIDENCE_DEFAULT}.`),
      dryRun: z.boolean().default(false).describe("Only return the candidates; change nothing."),
      skip: z.array(z.string().min(1)).optional().describe("Candidate ids (`p1`, `r2`…) from a dry run to leave out."),
    }),
    result: CleanupResultSchema,
  },
  "music.fit": {
    mutating: true,
    description:
      "Fit a music clip to the cut (ADR 0037): back-time it so the track's own final hit lands on `end` and it plays unspliced " +
      "before it, and report where the music then starts. `end` is a time on the timeline: seconds, or a marker id or label " +
      "(`end-card`, `outro-1`) or a beat or bar of the timeline's grid (`bar:16`, read on the clip as it is before the fit). The final hit is `hit` (source seconds of the music file) when given, else found on the track's " +
      "energy: the last sharp jump in level near the end of the part the clip plays, reported with a `confidence` and the other " +
      "`candidates`. Default (`mode: slide`): the clip slides so the hit lands on `end` within half a frame, keeping its speed. " +
      "Where that would start the music before `from` (default 0), the intro is dropped instead (`in` moves later, `introCut`); " +
      "where the clip plays the file from later than 0 and the start lands after `from`, the intro comes back as far as the file has it; " +
      "where the file is shorter than the picture before the hit, the music starts late (`silentBefore`), and it is never looped " +
      "or spliced. `exact: true` keeps the start (the clip's own, or `from`) and changes the speed so the hit lands exactly on " +
      "`end`: at most ±1.7 % of the clip's speed (export and preview keep the pitch); beyond that it refuses and says " +
      "which `end` would fit, or to drop `exact`. A detected hit under confidence 0.5 never changes the speed: pass `hit`. `dryRun: true` changes nothing and returns the plan with its `steps`. " +
      "If the clip carries duck keys (`track.duck`), they sit on the clip's clock and would no longer match the voice: duck runs " +
      "again in the same transaction over the other video and audio tracks with its defaults (`skip: [\"duck\"]` leaves them and " +
      "says so). Music keys (`music.shape`) are run again first with the settings kept on the clip, so the steps down stay on the hits of the picture " +
      "(`skip: [\"shape\"]` leaves them and says so). The clip's start gets a 5 ms fade in (`audio.fadeInMs`, so the entry does not click) " +
      "unless it already has a fade in or a dissolve (`skip: [\"fade\"]` leaves it out). Writes only existing fields (`start`, `in`, `speed`, `audio.fadeInMs`, gain keys) as one transaction labelled `Music fit: …` " +
      "(`revert` undoes it whole; with review mode on it is one proposal). Example: `{ clip: \"c_1a2b3c\", end: \"end-card\" }`. " +
      "Fails with InvalidOperation (not a music clip of an audio track, `end` not after `from`, a `hit` outside the played part, " +
      "no hit found, more than ±1.7 % needed, low confidence with `exact`, the new place overlaps another clip), " +
      "TimelineNotFound, ClipNotFound or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Music clip: a media clip of an audio track, id from `timeline.show`, e.g. `c_1a2b3c`."),
      end: TimeRef("Timeline time the final hit lands on, e.g. the cut into the end card."),
      from: TimeRef(
        "Earliest timeline time the music may start (default 0). With `exact`, where it starts (default: where the clip starts now).",
      ).optional(),
      hit: z
        .number()
        .positive()
        .optional()
        .describe("Source seconds of the music file where the final hit begins. Default: found on the track's energy (see `hit.candidates` of a dry run)."),
      exact: z
        .boolean()
        .default(false)
        .describe("Keep the start and land the hit exactly on `end` with a small change of speed (at most ±1.7 %). Default false: slide the clip, keep its speed."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
      skip: z.array(z.string().min(1)).optional().describe("Step ids from a dry run's `steps` to leave out; `fade`, `duck` and `shape` can be."),
    }),
    result: MusicFitResultSchema,
  },
  "music.candidates": {
    mutating: true,
    description:
      "Place 2 to 7 candidate music tracks under the same picture at the same loudness, so the person picks by ear (ADR 0037). Each file " +
      "in `assets` goes on its own new audio track `Music 1` to `Music n`, all muted but the first, with a static clip gain that brings its " +
      "EBU R128 integrated loudness (measured over the whole file, once per file, cached by content) to one target: `loudness` (LUFS) when " +
      "given, else the quietest file's own, so no candidate is made louder than it is (a warning says when a gain would push a peak over " +
      "-1 dBTP). The clip starts at `from` (default 0) and plays the whole file. With `end` (seconds, a marker id or label) each is fitted " +
      "like `music.fit` slides it: its own final hit (found on its energy) lands on `end`, the intro dropped where the file is longer than " +
      "the picture before it and the music starting late where it is shorter (never looped), and the candidates are ranked: files that " +
      "cover the picture first, then by how sure the final hit is, ties in the order given. Without `end` the order given is the rank. " +
      "A file that cannot be placed (silent, no sound, no final hit, undecodable) is listed in `skipped` and the rest go on. `dryRun: true` " +
      "changes nothing and returns the plan. Every clip is added with a 5 ms fade in (`audio.fadeInMs`). One transaction labelled `Music candidates: …` (`revert` undoes it whole; with review mode on it is " +
      "one proposal). To choose: `track.set` `muted: false` on the winner and `track.remove` with `force` on the others, then `music.fit` " +
      "the clip that stays. Example: `{ assets: [\"assets/music/a.wav\", \"assets/music/b.wav\", \"assets/music/c.wav\"], end: \"end-card\" }`. " +
      "Fails with InvalidOperation (fewer than 2 or more than 7 files, a file twice, none placeable, `end` not after `from`), AssetNotFound, " +
      "TimelineNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      assets: z
        .array(z.string().min(1))
        .min(2)
        .max(MUSIC_CANDIDATES_MAX)
        .describe("Music files inside the project, absolute or relative to `cwd`, e.g. `assets/music/theme.mp3`; 2 to 7, in the order of your preference."),
      end: TimeRef("Timeline time every final hit lands on, e.g. the cut into the end card.").optional(),
      from: TimeRef("Timeline time the music may start from (default 0).").optional(),
      loudness: z
        .number()
        .min(-70)
        .max(0)
        .optional()
        .describe("LUFS to bring every candidate to. Default: the quietest candidate's own loudness."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
    }),
    result: MusicCandidatesResultSchema,
  },
  "music.shape": {
    mutating: true,
    description:
      "Shape a music clip's level around the picture (ADR 0037): the music steps down BEFORE a hit instead of ducking after it, and fades out at the ending. " +
      "`drop` lists the times of the hits (timeline seconds, a marker id or label, `beat:N`/`bar:N`; the cut into the end card, a title slam, a sound effect). For each, " +
      "the music is `depth` dB down (default 9) over a quick step that is complete `lead` seconds before the hit (default 0.4), stays down until `hold` seconds after it (0.3) " +
      "and comes back over `release` (0.6). `ending` is where the closing fade begins (e.g. the end of the last word, or `bar:17` with a short `fade` to stop on a bar line): " +
      "the music fades straight down over `fade` seconds (default 2.5) to inaudible and stays there to the clip's end. The result is gain keys " +
      "(`clip.key` `gain`) on the clip, marked `auto: \"music\"`: running it again replaces those and keeps the keys you set by hand (a hand key inside a dip stays as set and " +
      "a warning names it); `clear: true` removes them. The level they dip from is the clip's `audio.gain` or its own keys. The times of the hits are kept in the clip's `audio.shape`, " +
      "so `music.fit` runs the same shaping again after it moves the clip (`skip: [\"shape\"]` leaves the keys and says so). The keys replace the clip's duck keys (`track.duck`): " +
      "duck runs again in the same transaction with its stored parameters, so the voice still ducks the shaped music. The clip's start also gets a 5 ms fade in " +
      "(`audio.fadeInMs`) unless it already has a fade in or a dissolve; `clear` leaves the clip's edges alone. Not done here: the rising high-pass build before a drop. " +
      "`dryRun: true` changes nothing and returns the `curve` and `steps`. One transaction labelled `Music shape: …` (`revert` undoes it whole; with review mode on it is one proposal). " +
      "Example: `{ clip: \"c_1a2b3c\", drop: [\"hit\"], ending: 28 }`. Fails with InvalidOperation (not a music clip of an audio track, nothing to shape, `clear` with `drop` or `ending`, " +
      "no time falls on the clip), ClipNotFound or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Music clip: a media clip of an audio track, id from `timeline.show`, e.g. `c_1a2b3c`."),
      drop: z
        .array(TimeRef("Timeline time of a hit the music steps down before."))
        .min(1)
        .max(32)
        .optional()
        .describe("Hits of the picture, as timeline times. The music is complete down `lead` seconds before each."),
      ending: TimeRef("Timeline time the closing fade begins.").optional(),
      lead: z.number().min(0.05).max(3).default(0.4).describe("Seconds before a hit that the step down is complete. Default 0.4."),
      depth: z.number().positive().max(40).default(9).describe("dB the music steps down by. Default 9."),
      hold: z.number().min(0).max(5).default(0.3).describe("Seconds after a hit the music stays down. Default 0.3."),
      release: z.number().min(0.05).max(5).default(0.6).describe("Seconds the level takes to come back after the hold. Default 0.6."),
      fade: z.number().min(0.05).max(15).default(2.5).describe("Seconds of the closing fade from `ending`. Default 2.5."),
      clear: z.boolean().default(false).describe("Remove the clip's `music` keys instead; takes no `drop` or `ending`."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
    }),
    result: MusicShapeResultSchema,
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
      "operation of this author. Fails with TransactionState when one is already open, and with ProposalPending while " +
      "a review-mode proposal waits (ADR 0019) in the project enclosing `cwd` (without `cwd`: in any open project): run " +
      "`proposal.wait`, then begin. With review mode on, the label is what the person reads when reviewing: give one " +
      "intent one transaction.",
    params: z.strictObject({
      cwd: CwdParam.optional().describe(
        "Absolute directory inside the project the transaction works on, e.g. `/home/ana/videos/launch`; only that " +
          "project's review-mode proposal refuses it. Omitted: a proposal in any open project does.",
      ),
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
      "In review mode its operations now wait for review as one proposal (`proposal`): call `proposal.wait`. " +
      "Fails with TransactionState when none is open.",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      operations: z.int().describe("Operations applied in the transaction."),
      proposal: z
        .object({ tx: z.string(), state: ProposalStateSchema })
        .nullable()
        .describe("Review mode (ADR 0019): the proposal holding the transaction's operations, now `ready`; null when they were applied."),
    }),
  },
  "tx.abort": {
    mutating: true,
    description:
      "Close this session's explicit transaction and undo its changes: on every timeline it touched, its operations' " +
      "inverses are applied newest first as one `revert` operation inside the transaction. All or nothing: every " +
      "timeline is checked first, and when someone else changed the same tracks or clips since on any of them, nothing " +
      "is undone and it fails with RevertConflict listing each conflicting timeline in `timelines` (transaction stays " +
      "open). In review mode, a proposal still building from it is dropped: nothing of it reached the file. Operations " +
      "that did reach the file (applied before review mode was turned on) are not undone at once: the undo waits for " +
      "review as a new proposal (`proposal`, labelled `Abort \"<label>\"`); call `proposal.wait`. Its project-config " +
      "changes (`format.add`/`format.remove`, ADR 0036) are undone too, checked before anything is undone; while review " +
      "mode is on only the person may abort a transaction that changed config (ProposalState `forbidden`). Fails with " +
      "TransactionState when none is open, ProposalPending when another proposal waits (transaction stays open).",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      reverted: z.array(OperationResultSchema).describe("One `revert` operation per timeline the transaction changed and this undid."),
      config: z.array(ConfigOperationSchema).describe("One config `revert` operation per config document it changed and this undid (ADR 0036)."),
      proposal: z
        .object({ tx: z.string(), state: ProposalStateSchema })
        .nullable()
        .describe("Review mode (ADR 0019): the `ready` proposal holding the undo; null when it was applied or nothing reached the file."),
    }),
  },
  history: {
    description:
      "List a timeline's journaled operations grouped by transaction, oldest first: op, args, author (`ui`, " +
      "`cli:<session>`, `agent:<label>:<session>`, `file`, `plugin:<name>`), revisions and touched ids. Project-config " +
      "operations (`format.add`/`format.remove`, ADR 0036) are listed in every timeline's history, in their transaction, " +
      "with `doc` set and their keys (e.g. `format:9x16`) as `touched`. Pass `since` with your last transaction id " +
      "to see only what happened after it, e.g. what the human changed in the app. Fails with HistoryNotFound when " +
      "`since` is in neither this timeline's journal nor the config journal.",
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
      "a transaction from `history` changed before you `revert` it. A target only in the project-config journal " +
      "(`format.add`/`format.remove`, ADR 0036) changed no clips: `clips` is empty. Fails with HistoryNotFound when the " +
      "id is in neither journal, or changed only other timelines (`data.timelines` names them), HistoryUnavailable when the file changed outside the journal after the target.",
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
      "edited while the daemon was not running): the journal cannot undo what it did not record, so edit forward. " +
      "Project-config operations (`format.add`/`format.remove`, ADR 0036) revert too: by their `op`, or with the `tx` " +
      "that holds them, which undoes its timeline and config operations together; a later change of the same format " +
      "conflicts like a clip (`ids` holds keys such as `format:9x16`), and a hand edit of `formats` in `frameshell.json` " +
      "refuses like a hand edit of the timeline. When only config was reverted, `operation` is the config `revert` with " +
      "an empty inverse and `revision` is unchanged; `config` lists the config `revert` operations. While review mode " +
      "is on, only the person may revert config (ProposalState `forbidden` for others). A transaction that changed " +
      "several timelines reverts one timeline per call: its config goes with the first, later calls skip it. Fails " +
      "with HistoryNotFound when the id is in neither the timeline's journal nor the config journal, or changed only " +
      "other timelines (`data.timelines` names them: pass one as `timeline`).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to undo."),
    }),
    result: OperationResultSchema.extend({
      config: z.array(ConfigOperationSchema).describe("Config `revert` operations it journaled (ADR 0036); empty when the target held none."),
    }),
  },
  "review.set": {
    mutating: true,
    internal: true,
    description:
      "Turn review mode (ADR 0019) on or off for the project enclosing `cwd`, stored per user in `<configDir>/review.json`. " +
      "Only the app (author `ui`) may; anyone else gets ProposalState (reason `forbidden`). Turning it off leaves an " +
      "open proposal to be decided.",
    params: z.strictObject({
      cwd: CwdParam,
      enabled: z.boolean().describe("True: changes not made in the app wait as proposals."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      enabled: z.boolean(),
    }),
  },
  "proposal.status": {
    description:
      "Review mode (ADR 0019) of the project: whether the person turned it on, the open proposal (author, label, state, " +
      "operations, timelines, age) and the last decisions. While review mode is on, your timeline and format changes do not touch " +
      "the file: they wait as one proposal per transaction until the person accepts or rejects it in the app. Your own " +
      "reads show the proposal's version (`view: \"proposal\"`).",
    params: z.strictObject({ cwd: CwdParam }),
    result: ReviewStateSchema.extend({ dir: z.string().describe("Project root.") }),
  },
  "proposal.wait": {
    description:
      "Block until the project's open review-mode proposal (ADR 0019) is decided, then say how: `accepted` (applied, " +
      "continue), `rejected` (ask the person what to change), `stale` (the person changed the same clips: re-read the " +
      "timeline and redo; `conflicts` names the ids) or `aborted`. After `timeout` seconds it returns `pending`: call " +
      "it again. With no open proposal it returns the last decision at once, or `none`. Call it after a change fails " +
      "with ProposalPending, or after your transaction closes in review mode.",
    params: z.strictObject({
      cwd: CwdParam,
      timeout: z
        .number()
        .positive()
        .max(PROPOSAL_WAIT_MAX_S)
        .optional()
        .describe(`Seconds to wait at most, e.g. \`120\`. Default ${PROPOSAL_WAIT_DEFAULT_S}, max ${PROPOSAL_WAIT_MAX_S}.`),
    }),
    result: z.object({
      outcome: z
        .enum([...ProposalOutcomeSchema.options, "pending", "none"])
        .describe("How the proposal ended; `pending`: still open after `timeout`; `none`: no proposal now or before."),
      tx: z.string().nullable().describe("The proposal's id; null for `none`."),
      label: z.string().nullable(),
      author: z.string().nullable(),
      conflicts: z.array(z.string()).describe("`stale`: ids both you and the person changed. Empty otherwise."),
      proposal: ProposalSchema.nullable().describe("`pending`: the proposal still open. Null otherwise."),
    }),
  },
  "proposal.diff": {
    description:
      "What the open review-mode proposal (ADR 0019) changes, per timeline, from the file to the proposal's version: " +
      "each clip it adds, removes, moves (other track or start, same length) or otherwise changes, with its track, " +
      "start and end before and after, in the shape of `history.diff` (the marks the app shows on the timeline). " +
      "`config` lists the project-config keys it changes (ADR 0036), e.g. `format:9x16`. " +
      "Without `tx` the open proposal; `timelines` and `config` are empty and `tx` null when none is open. Fails with ProposalState " +
      "(`decided` or `unknown`) when `tx` is not the open proposal.",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.optional().describe("The proposal's id. Default: the open proposal.") }),
    result: z.object({
      tx: z.string().nullable().describe("The proposal diffed; null when none is open."),
      timelines: z.array(HistoryDiffResultSchema).describe("One per timeline the proposal changes, `target` = its id; in the order it first changed them."),
      config: z
        .array(ProposalConfigChangeSchema)
        .describe("Every config key it changes, with the file's value (`before`) and the proposal's (`after`); null = absent."),
    }),
  },
  "proposal.accept": {
    mutating: true,
    internal: true,
    description:
      "Apply the ready proposal `tx` (ADR 0019): its operations are journaled in order under their author, transaction " +
      "and label, each marked `proposal: <tx>`, on every timeline and config document or none (config is written first). " +
      "Only the app (author `ui`) may. Fails with " +
      "ProposalState: `forbidden` (not `ui`), `building` (not ready), `decided`/`unknown` (not the open proposal), or " +
      "`stale` (the person's edit overlaps it; it is closed as stale).",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.describe("The proposal's id.") }),
    result: z.object({
      tx: z.string(),
      operations: z.array(OperationResultSchema).describe("The journaled timeline operations, in order."),
      config: z.array(ConfigOperationSchema).describe("The journaled config operations (ADR 0036), in order; empty when none."),
    }),
  },
  "proposal.reject": {
    mutating: true,
    internal: true,
    description:
      "Refuse the open proposal `tx` (ADR 0019), ready or still building: nothing is journaled; its file stays in " +
      "`.frameshell/proposals/` for 7 days. Only the app (author `ui`) may. Fails with ProposalState: `forbidden`, " +
      "`decided` or `unknown`.",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.describe("The proposal's id.") }),
    result: z.object({ tx: z.string() }),
  },
  "style.show": {
    description:
      "The project's style guide (ADR 0028): `style.json` at the project root, with measurable values for every " +
      "visual and sound decision: `brand` (product, hook, CTA, audience; `?` = ask the person), `colors` (hex), " +
      "`fonts` (family, file under `assets/fonts/`, weight, tracking in em), `type` (px on a frame whose short side " +
      "is 1080), `motion` (seconds; `personality` playful, premium, corporate, energetic or calm, then the file's " +
      "overrides), `sound` (dB under the voice, ducking, voice-chain defaults; the loudness target stays " +
      "`export.loudness`), `platforms`, `notes`, `rules`, `banned`. Every value is `{ value, source }`: `file` " +
      "(written in style.json), `personality` (from its motion personality) or `default` (Frameshell's; null = not " +
      "decided, ask the person). `safeZones`: for each platform named, the pixels of a reference frame its app " +
      "covers (`measured: false` = from editing guides). `style` is null when the project has no style.json: none " +
      "is required. `from.status` says whether the user style it was copied from changed since (`style.apply` it " +
      "again to take the change). While a review-mode proposal changes the style (ADR 0036), `view: \"proposal\"` " +
      "shows its version. Read-only; nothing renders from it yet. Fails with InvalidProjectFile when the file is invalid.",
    params: z.strictObject({ cwd: CwdParam, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
      dir: z.string().describe("Project root."),
      path: z.string().describe("The style file, project-relative: `style.json`."),
      style: ResolvedStyleSchema.nullable().describe("Every value with its source; null when there is no style.json."),
      from: z
        .object({
          id: z.string(),
          sha256: z.string(),
          status: z
            .enum(["same", "changed", "missing"])
            .describe("`same`: the user style still holds what was copied. `changed`: edited since. `missing`: no user style with that id on this machine."),
        })
        .nullable()
        .describe("User style the file was copied from (id, SHA-256 at copy time); null when none."),
      safeZones: z.array(SafeZoneSchema).describe("Safe zone of each platform in `platforms`, in that order; empty when none."),
    }),
  },
  "style.set": {
    mutating: true,
    description:
      "Set one value of the project's style guide (`style.json`, ADR 0028) by its dotted path, e.g. " +
      "`{ path: \"colors.accent\", value: \"#ff5500\" }`, `{ path: \"motion.personality\", value: \"premium\" }`, " +
      "`{ path: \"type.hero\", value: 220 }`, `{ path: \"banned\", value: [\"emoji in captions\"] }`. A path names one " +
      "value: a colour, a number, a font object (`fonts.display`: `{ family, file?, weight?, tracking? }`), an ease (4 " +
      "numbers) or a whole list; `style.show` lists every path. `value: null` removes it from the file, so the " +
      "personality's or the default value applies again. Units as `style.show` describes them (seconds, not ms). " +
      "Creates `style.json` when missing; the rest of the file is kept. Journaled in " +
      "`.frameshell/history/project.config.jsonl` in the caller's transaction (ADR 0036): `history` lists it, `revert` " +
      "with its `op` or `tx` undoes it. While review mode is on (ADR 0019), a change by anyone but the person in the app " +
      "waits in the transaction's proposal (`proposal` in the result). Change the style only with the person's agreement. " +
      "Fails with InvalidOperation (`reason`: `path` unknown, `value` invalid, with the schema's message), " +
      "InvalidProjectFile (the file on disk is invalid), ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      path: z.string().min(1).describe("Dotted path of one style value, e.g. `colors.accent`, `motion.duration.quick`, `sound.duck.depth`."),
      value: z.unknown().describe("New value as JSON (string, number, boolean, list, font object); null removes it from the file."),
    }),
    result: StyleChangeSchema,
  },
  "style.apply": {
    mutating: true,
    description:
      "Copy a user style (a library in Frameshell's config folder, `style.list`) or a motion personality (`playful`, " +
      "`premium`, `corporate`, `energetic`, `calm`) into the project's `style.json` (ADR 0028 decision 10). By default " +
      "it merges value by value: every value the user style sets replaces the project's, the others stay. " +
      "`replace: true` makes the file exactly the user style. A user style also records `from` (its id and SHA-256), " +
      "so `style.show` can say when it changed later; nothing is inherited afterwards. A personality sets only " +
      "`motion.personality` (with `replace`, it is all the file keeps). `changes` reports every value that changed. " +
      "Journaled and held by review mode like `style.set`; `revert` with its `op` undoes it. Fails with InvalidOperation " +
      "(`reason` `not found`, with the user styles available in `data.available`), InvalidGlobalConfig (the user style " +
      "is invalid), InvalidProjectFile, ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: UserStyleIdSchema.describe("User style id (`style.list`) or a motion personality id."),
      replace: z.boolean().optional().describe("Overwrite the project's style with it instead of merging value by value. Default false."),
    }),
    result: StyleChangeSchema,
  },
  "style.save": {
    mutating: true,
    description:
      "Save the project's `style.json` as user style `name` in Frameshell's config folder (`styles/<name>.json`), so " +
      "other projects can `style.apply` it. The file is copied as it is, without `from`. Not a project change: not " +
      "journaled, not held by review mode. An existing user style of that name is kept unless `force: true`. Fails " +
      "with InvalidOperation (`reason` `no style`: the project has no style.json; `exists`; `personality`: the name is a " +
      "motion personality's), InvalidProjectFile, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: UserStyleIdSchema,
      force: z.boolean().optional().describe("Overwrite a user style of the same name. Default false."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      id: z.string().describe("User style id."),
      path: z.string().describe("Absolute path of the user style file."),
      sha256: z.string().describe("SHA-256 of the user style file as written."),
      replaced: z.boolean().describe("True when it overwrote a user style of the same name."),
    }),
  },
  "style.list": {
    description:
      "The user styles saved on this machine (`style.save`; files `styles/<id>.json` in Frameshell's config folder) " +
      "and the motion personalities, both names `style.apply` takes. A user style that fails validation is listed " +
      "with `error` and cannot be applied until fixed.",
    params: z.strictObject({}),
    result: z.object({
      dir: z.string().describe("Absolute folder of the user styles."),
      styles: z
        .array(
          z.object({
            id: z.string(),
            sha256: z.string().describe("SHA-256 of the file."),
            personality: z.string().nullable().describe("Motion personality it picks; null when none."),
            error: z.string().nullable().describe("Why it is invalid; null when it is valid."),
          }),
        )
        .describe("Sorted by id."),
      personalities: z.array(z.string()).describe("Motion personality ids."),
    }),
  },
  "people.list": {
    description:
      "The project's people (ADR 0020, `people.json`): who is who across transcripts, multicam angles and faces. Each " +
      "person has an id (`p_3fa2c1`), a unique name and links: `speakers` (a transcript and one of its speaker ids, or " +
      "every word of it), `angles` (timeline, group, angle) and `faces` (anchors: video, second, point of the face). A " +
      "link whose target is gone (transcript, speaker, timeline, group, angle or video) has `missing: true` and a " +
      "`reason`; it is ignored, never removed (a later run may bring it back). `dismissed` holds suggestion ids " +
      "answered \"no\". Empty `people` when the project has no `people.json`: everything works without it. Fails " +
      "with InvalidProjectFile when the file is invalid.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      people: z.array(PersonInfoSchema).describe("In file order."),
      dismissed: z.array(z.string()),
    }),
  },
  "people.add": {
    mutating: true,
    description:
      "Add a person to `people.json` (created when missing) with no links yet; link voices, angles and faces with " +
      "`people.link`. `name` is free text, unique ignoring case. The id is generated (`p_` + 6 hex). Example: " +
      "`{ name: \"Juan\" }`. Fails with InvalidOperation (reason `name taken`, naming who has it) or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, name: z.string().trim().min(1).describe("Display name, e.g. `Juan`.") }),
    result: z.object({ dir: z.string().describe("Project root."), person: PersonInfoSchema }),
  },
  "people.rename": {
    mutating: true,
    description:
      "Rename a person. Every transcript speaker linked to them gets the new name in its transcript's `speakers` " +
      "list too, so subtitles, export and anyone reading a words file see it (`transcripts` lists the files " +
      "written). Linked transcripts that are missing or invalid are listed in `skipped` and left alone; angle names " +
      "are not rewritten (that is a timeline edit: use `multicam.angle`). `person` is an id or the exact name. " +
      "Example: `{ person: \"Juan\", name: \"Juan Pérez\" }`. Fails with InvalidOperation (reason `unknown person` or " +
      "`name taken`) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      person: z.string().min(1).describe("Person id (`p_3fa2c1`) or exact name (ignoring case)."),
      name: z.string().trim().min(1).describe("New display name, unique ignoring case."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: PersonInfoSchema,
      previous: z.string().describe("The name before."),
      transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the new name."),
      skipped: z
        .array(z.object({ transcript: z.string(), reason: z.string() }))
        .describe("Linked transcripts the name could not be written to, and why. Empty when all went well."),
    }),
  },
  "people.remove": {
    mutating: true,
    description:
      "Remove a person and all their links from `people.json`. Transcript speaker names already written stay as " +
      "they are. `removed` is the person as they were, links included, so a mistake is undone by `people.add` and " +
      "`people.link` again. `person` is an id or the exact name. Fails with InvalidOperation (reason `unknown " +
      "person`) or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, person: z.string().min(1).describe("Person id or exact name.") }),
    result: z.object({ dir: z.string().describe("Project root."), removed: PersonInfoSchema }),
  },
  "people.link": {
    mutating: true,
    description:
      "Link something to a person: pass exactly one of `speaker` (a transcript speaker, or a whole transcript with " +
      "no `speaker`), `angle` (timeline, group, angle id) or `face` (an anchor: video, source second, and the point " +
      "of the face as fractions of the picture, default the center). The target must exist now. A speaker, angle or " +
      "anchor belongs to at most one person; a whole transcript excludes other people's speakers of it. Linking a " +
      "transcript speaker writes the person's name into that transcript's `speakers` entry (`transcripts`), so " +
      "subtitles and export show it; angle names are not rewritten. Linking what is already theirs changes nothing " +
      "(`linked: false`). Called by an agent, the link records it in `by`. Example: `{ person: \"Juan\", speaker: " +
      "{ transcript: \"transcripts/ep1.words.json\", speaker: \"s1\" } }`. Fails with InvalidOperation (reason " +
      "`unknown person`, `bad target`, `target missing` or `already linked`, naming the owner) or InvalidProjectFile.",
    params: z
      .strictObject({
        cwd: CwdParam,
        person: z.string().min(1).describe("Person id or exact name."),
        ...PersonTargetParams,
      })
      .refine((params) => [params.speaker, params.angle, params.face].filter((target) => target !== undefined).length === 1, {
        message: "pass exactly one of `speaker`, `angle` or `face`",
      }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: PersonInfoSchema,
      linked: z.boolean().describe("False when the link already existed."),
      transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the person's name."),
    }),
  },
  "people.unlink": {
    mutating: true,
    description:
      "Remove one link from a person: pass exactly one of `speaker`, `angle` or `face`, as `people.link` took it " +
      "(a face by its asset, `at`, `x` and `y`). Works when the target is gone. The name already written into a " +
      "transcript stays. Fails with InvalidOperation (reason `unknown person`, `bad target` or `not linked`, " +
      "listing the person's links) or InvalidProjectFile.",
    params: z
      .strictObject({
        cwd: CwdParam,
        person: z.string().min(1).describe("Person id or exact name."),
        ...PersonTargetParams,
      })
      .refine((params) => [params.speaker, params.angle, params.face].filter((target) => target !== undefined).length === 1, {
        message: "pass exactly one of `speaker`, `angle` or `face`",
      }),
    result: z.object({ dir: z.string().describe("Project root."), person: PersonInfoSchema }),
  },
  "people.scan": {
    description:
      "Find the faces in video assets so people can be recognized (ADR 0020), locally on CPU: 2 frames per second, the YuNet " +
      "detector then the SFace recognizer (ONNX Runtime; the first run downloads about 39 MB of models from OpenCV's model " +
      "zoo), the same face joined over time into tracks, one 128-number face print per track per second for faces of at " +
      "least 32 px. Never run on import: ask for it. Default: every video in `assets/` (still pictures are skipped). " +
      "The result is cached per file content in `.frameshell/people/` (regenerable, swept by `gc`, never read by " +
      "`people.json`): a video already scanned is not decoded again unless `force: true`. Nothing is linked to anyone; " +
      "`people.link` does that. Takes about 5 minutes per hour of footage with one face; progress " +
      "arrives as `progress` notifications. It runs as a background job of kind `people` (`job.list`), so it goes on if " +
      "the caller disconnects. Example: `{ assets: [\"assets/ep1.mp4\"] }`. Fails with AssetNotFound, InvalidOperation " +
      "(reason `bad target`: an asset outside the project), or the Binary* errors when ffmpeg, ONNX Runtime or a model " +
      "cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      assets: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Videos to scan: project-relative (`assets/ep1.mp4`) or absolute. Default: every video in `assets/`."),
      force: z.boolean().optional().describe("Scan again even when the content's scan is cached. Default false."),
    }),
    result: PeopleScanResultSchema,
  },
  "people.ranges": {
    description:
      "When a person speaks or is on screen on a timeline (ADR 0020): merged `spans` `{ start, end }` in timeline seconds, " +
      "sorted, pauses under 0.5 s bridged, with their `total`. `kind` `speaks` (default): the words of the person's linked " +
      "transcript speakers placed by the clips that play their video or audio (in, out, speed and cuts honoured; nested " +
      "timelines flattened; a mic's words through the shots) plus the speaking turns of their linked multicam angles inside " +
      "the program track's shots. `onscreen`: the shots that show one of their angles, plus their faces (`people.scan`; the " +
      "faces their face anchors name, and the faces clustered with those) placed by the video clips that show each video, " +
      "0.25 s either side of each face sample. Clips covered by a layer above are not subtracted; on a program track only " +
      "the shot's angles count. Spans are timeline seconds NOW: to cut several out with `ripple`, go from the " +
      "last span to the first so earlier spans keep their times. Links whose target is gone are skipped with a `warnings` " +
      "line. Read-only. Fails with InvalidOperation (reason `unknown person`), InvalidProjectFile or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      person: z.string().min(1).describe("Person id or exact name."),
      kind: z.enum(["speaks", "onscreen"]).default("speaks").describe("`speaks` (default) or `onscreen`."),
      timeline: TimelineIdSchema,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: z.object({ id: z.string(), name: z.string() }),
      kind: z.enum(["speaks", "onscreen"]),
      timeline: z.string(),
      spans: z.array(z.object({ start: z.number(), end: z.number() })).describe("Timeline seconds, sorted, disjoint."),
      total: z.number().describe("Seconds covered by `spans`."),
      warnings: z.array(z.string()),
    }),
  },
  "people.suggest": {
    description:
      "Links Frameshell suggests and nobody confirmed yet (ADR 0020); nothing is linked until `people.confirm`. Kind " +
      "`speaker`: a transcript speaker linked to nobody whose voice sounds like one person's linked speakers (voice " +
      "prints: CAM++ embeddings of each speaker's longest stretches alone, computed locally on first use, a few " +
      "seconds per transcript, then cached in `.frameshell/people/voices/`; the speaker model is downloaded once); at " +
      "most one per speaker. Faces come from `people.scan` (cached scans only; this never scans): face tracks of every " +
      "video are clustered by face print, and a face anchor makes its cluster the person's. Kind `face`: a face on " +
      "screen for 10 s or more that nobody has, with the person it looks like or none (ask \"Who is this?\" and show " +
      "the frame at `face.anchor`). Kind `face-speaker`: in a video with a diarized transcript, the face on screen for " +
      "60% or more of a speaker's time (and the only one): the voice and the face are one person, joined to the person " +
      "either side already has, or a new one. Kind `angle`: a multicam angle (not a screen) linked to nobody: the person " +
      "named like it ignoring case, or a new person with its name, plus the angle's voice (its `speaker`, else the " +
      "speaker holding 80% of its sound's words, else the whole transcript of a mic of its own) and, when videos were " +
      "scanned, the face most on screen in that angle; one confirmation links all of it. Kind `script` (shoots, ADR 0024): a " +
      "transcript speaker, or a whole transcript without speakers (your own mic), that says 80% or more of its words in a " +
      "shoot script's lines of one `**Name:**` (at least 5 words, takes compared with their transcripts): the person of " +
      "that name, or a new one with it; then `speaker` deviations of those takes name that person. Suggestions answered \"no\" (`dismissed`) are left out. `hints` say what " +
      "keeps voices or faces from being matched: no person has a linked speaker yet, a transcript has no speakers (run " +
      "`transcribe.speakers`), is stale, a speaker says too little, a video has no face scan (run `people.scan`), or a " +
      "face anchor names no face. Confirm only what the person agreed to or what is certain.",
    params: z.strictObject({
      cwd: CwdParam,
      download: z
        .boolean()
        .default(true)
        .describe(
          "Download the voice model (CAM++ and ONNX Runtime Web, about 60 MB, once) when voices must be compared and it " +
            "is missing. Default true. False: voices are left out instead and `voiceDownload` says what it would fetch.",
        ),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      suggestions: z.array(PeopleSuggestionSchema),
      hints: z.array(z.string()).describe("Why some voices or faces could not be compared, with the command that fixes it. Empty when none."),
      voiceDownload: z
        .object({ bytes: z.int().nonnegative().describe("Bytes still to download.") })
        .optional()
        .describe("Only with `download: false`: voices were left out because the voice model is not downloaded yet."),
    }),
  },
  "people.confirm": {
    mutating: true,
    description:
      "Answer suggestions from `people.suggest` by id: yes applies each one's links (as `people.link`: a speaker's " +
      "person's name is written into the transcript, a face is linked as a face anchor at `face.anchor`; called by an " +
      "agent, the link records it in `by`), `reject: true` adds the ids to `dismissed` in `people.json` so they are not " +
      "suggested again. A suggestion without `person` (a new face, or a voice and face nobody has) needs `person`: an " +
      "existing person, or a new name, which adds that person (an `angle` suggestion without `person` adds a person named like the angle, a `script` one a person named like its `**Name:**`). Ids are checked against the current suggestions first: " +
      "one no longer suggested, or one needing `person` without it, fails the call before anything changes. Undo a yes " +
      "with `people.unlink` (and `people.remove` for a person it added). Example: `{ suggestions: [\"sg_9c04e1d2\"] }`, " +
      "`{ suggestions: [\"sg_51aa07c3\"], person: \"Ana\" }`. Fails with InvalidOperation (reason `unknown suggestion`, " +
      "`needs person`, or a `people.add` or `people.link` reason) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      suggestions: z
        .array(z.string().regex(/^sg_[0-9a-f]{8}$/, "must look like `sg_9c04e1d2`"))
        .min(1)
        .describe("Suggestion ids from `people.suggest`."),
      reject: z.boolean().default(false).describe("True dismisses them instead of linking. Default false."),
      person: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("For suggestions that name no person: who it is, by id or exact name; a name nobody has adds that person. Ignored by the others."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      confirmed: z
        .array(
          z.object({
            id: z.string(),
            person: z.object({ id: z.string(), name: z.string() }),
            added: z.boolean().describe("True when the person was added by this confirmation (`person` named nobody)."),
            speaker: z.object({ transcript: z.string(), speaker: z.string().optional() }).optional().describe("The speaker linked, when the suggestion linked one (no `speaker`: the whole transcript)."),
            angle: z.object({ timeline: z.string(), group: z.string(), angle: z.string() }).optional().describe("The angle linked, when the suggestion linked one."),
            face: FacePointSchema.optional().describe("The face anchor linked, when the suggestion linked one."),
            linked: z.boolean().describe("False when every link already existed."),
            transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the person's name."),
          }),
        )
        .describe("Links applied, in request order. Empty with `reject`."),
      dismissed: z.array(z.string()).describe("Ids added to `dismissed`. Empty without `reject`."),
    }),
  },
  "ui.state": {
    description:
      "What the user sees in the Frameshell app for this project: the playhead and whether it plays, the selection " +
      "(clip ids, transcript words, a time range, the History entry whose changes the timeline marks, and the person picked " +
      "in the People panel with their spans), the " +
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
      "names, from `timeline.show`), transcript words, and/or a time range; or a person with their spans and words. " +
      "Omitted parts are cleared; nothing given clears the selection. With `reveal` (default true) the timeline scrolls " +
      "to the first clip (or span) and, unless playing, the playhead moves to its start. Examples: `{ clips: [\"c_1a2b3c\"] }`, `{ range: { from: 12.4, to: 13.1 } }`, " +
      "`{ person: { id: \"Juan\" } }`. Returns `ui.state`. Fails with UiCommandFailed naming clip ids the timeline does " +
      "not have, InvalidOperation for an unknown person, UiNotConnected.",
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
      points: z
        .array(
          z.object({
            at: z.number().nonnegative().describe("Timeline seconds."),
            x: z.number().min(0).max(1).describe("Fraction of the frame width."),
            y: z.number().min(0).max(1).describe("Fraction of the frame height."),
          }),
        )
        .default([])
        .describe(
          "Points of the preview to show as picks (ADR 0011), e.g. `[{ at: 12.4, x: 0.71, y: 0.14 }]`, each inspected as " +
            "`inspect.point` does, so the user sees the element you mean outlined. Replaces clips, words and range. Default none.",
        ),
      person: z
        .object({
          id: z.string().min(1).describe("Person id `p_…` or the exact name, as `people.list` reports them."),
          what: z.enum(["speaks", "onscreen"]).default("speaks").describe("Their time to select: when they speak (default) or when they are on screen."),
        })
        .nullable()
        .default(null)
        .describe(
          "A person to select as the People panel does (ADR 0020): their spans of the main timeline (`people.ranges`) and, " +
            "with `speaks`, the words of their linked voices; `ui.state` then reports `person`. Replaces clips, words and range. Default none.",
        ),
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
    params: z.strictObject({
      cwd: CwdParam,
      view: UiViewIdSchema,
      state: UiViewSchema,
      focused: z
        .boolean()
        .optional()
        .describe(
          "The window is the one the user focused last among the app's project windows (still true after the app loses " +
            "focus). False: it reports in the background, e.g. while playing, and does not become `ui.active`. Default true.",
        ),
    }),
    result: z.object({ dir: z.string().describe("Project root the window is registered for.") }),
  },
  "ui.active": {
    description:
      "Project of the app window the user works in: the one focused last (else the one that reported last), the same " +
      "window `ui.*` commands for that project reach. `dir` is null when no app window shows a project. The MCP server " +
      "resolves a call without `cwd` to it when the server's own directory is in no project (ADR 0014).",
    internal: true,
    params: z.strictObject({}),
    result: z.object({
      dir: z.string().nullable().describe("Absolute project root the window shows; null when no window shows one."),
    }),
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
      stage: z
        .string()
        .optional()
        .describe(
          "Stable code of the step, so a UI can say it in its own language: `hash`, `extract-audio`, `binary`, " +
            "`binary-download`, `binary-fallback`, `model`, `model-download`, `model-load`, `gpu-compile`, `gpu-compiled`, " +
            "`gpu-retry`, `transcribe`, `retranscribe`, `diarize`, `faces`, `people`, `matte` (`values`: `asset`, `eta` seconds left once known), `capture` (`values`: `url`). Codes may be added: treat an unknown one as `message`.",
        ),
      values: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe("Facts the `stage` line is built from (`name`, `model`, `size` in MB, `device`, `seconds`…); `message` already has them in English."),
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
      warnings: z
        .array(z.string())
        .optional()
        .describe("What the change did beyond what was asked, e.g. a `behind` cleared because a direct edit removed or moved its plate. Absent: none."),
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
  "proposal.changed": {
    description:
      "The project's review-mode proposal (ADR 0019) changed: opened or grew (`building`), became `ready`, was rebased " +
      "on the person's edit (same state), or closed (`accepted`, `rejected`, `stale`, `aborted`). `timeline.changed` " +
      "stays about files only: an accepted proposal's operations send it as they are written.",
    params: z.object({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
      tx: z.string().describe("The proposal's id."),
      label: z.string().nullable(),
      author: z.string(),
      state: ProposalStateSchema,
      operations: z.int().describe("Operations it holds, every timeline and config document."),
      timelines: z.array(z.string()).describe("Ids of the timelines it changes."),
      config: z.array(ProposalConfigChangeSchema).describe("Project-config keys it changes (ADR 0036); empty when none."),
      conflicts: z.array(z.string()).describe("`stale`: ids or config keys both the person and the proposal changed. Empty otherwise."),
    }),
  },
  "people.changed": {
    description:
      "`people.json` changed by a people method (ADR 0020): a person was added, renamed or removed, or one of their " +
      "links was added or removed. Sent to connections subscribed with `events.subscribe`, after the file is written. " +
      "A hand edit of the file sends nothing. Re-read with `people.list`.",
    params: PeopleChangedSchema,
  },
  "shoot.changed": {
    description:
      "A shoot file changed or a take was compared (ADR 0023). Sent to connections subscribed with `events.subscribe`. " +
      "Re-read with `shoot.status`.",
    params: ShootChangedSchema,
  },
  "beats.changed": {
    description:
      "A beats file of the project (`beats/*.beats.json`, ADR 0029) was written (by `beats.measure`, a generator, `file.write` or a hand " +
      "edit), deleted, or became invalid. Sent to connections subscribed with `events.subscribe`, after the write settled. A timeline " +
      "whose `tempo` follows that asset has a new grid: read it again with `tempo.show`.",
    params: z.object({
      project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
      file: z.string().describe("Project-relative beats file, e.g. `beats/song.beats.json`."),
      change: z.enum(["written", "removed", "invalid"]).describe("`written`: valid content now; `removed`: the file is gone; `invalid`: it does not parse or validate (`message`), so its grid is unavailable until fixed."),
      message: z.string().optional().describe("`invalid`: what is wrong with the file."),
    }),
  },
  "target.changed": {
    description:
      "The project's agent targets (ADR 0025) changed: one registered or left, a reference was queued for one, or one " +
      "read its references (`read`). Sent to connections subscribed with `events.subscribe`.",
    params: TargetChangedSchema,
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
/** `transcribe.speakers` params. */
export type TranscribeSpeakersParams = MethodParams<"transcribe.speakers">;
/** Result of `transcribe.speakers`. */
export type TranscribeSpeakersResult = MethodResult<"transcribe.speakers">;
/** One word of `transcribe.verify` `lost`. */
export type LostWord = z.output<typeof LostWordSchema>;
/** One word of `transcribe.verify` `uncertain`. */
export type UncertainWord = z.output<typeof UncertainWordSchema>;

/** Result of `proposal.status`. */
export type ProposalStatusResult = MethodResult<"proposal.status">;
/** Result of `proposal.wait`. */
export type ProposalWaitResult = MethodResult<"proposal.wait">;

/** Result of `style.show`. */
export type StyleShowResult = MethodResult<"style.show">;
/** Result of `script.outline`. */
export type ScriptOutlineResult = MethodResult<"script.outline">;
/** Result of `shoot.status`. */
export type ShootStatusResult = MethodResult<"shoot.status">;
/** Result of `script.check`. */
export type ScriptCheckResult = MethodResult<"script.check">;
/** Result of `voiceover.generate`. */
export type VoiceoverGenerateResult = MethodResult<"voiceover.generate">;
/** Result of `voiceover.place`. */
export type VoiceoverPlaceResult = MethodResult<"voiceover.place">;
/** Result of `brand.capture`. */
export type BrandCaptureResult = MethodResult<"brand.capture">;
/** Result of `sound.sfx`. */
export type SoundSfxResult = MethodResult<"sound.sfx">;
/** Result of `sound.place`. */
export type SoundPlaceResult = MethodResult<"sound.place">;
/** Result of `sound.music`. */
export type SoundMusicResult = MethodResult<"sound.music">;

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
/** H.264 encoder ranking in a {@link DoctorResult}: what renders use and what was tried. */
export type EncoderReport = z.output<typeof EncoderReportSchema>;
/** One H.264 encoder Frameshell can pick, in the order tried. */
export type EncoderName = z.output<typeof EncoderNameSchema>;
/** Encode quality tier. */
export type QualityTier = z.output<typeof QualityTierSchema>;
/** Speed class and recommended sizes of a machine in a {@link DoctorResult}. */
export type MachineProfile = z.output<typeof MachineProfileSchema>;
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
/** Result of `batch.render`. */
export type BatchRenderResult = MethodResult<"batch.render">;
/** One row × format of a batch; see {@link BatchEntrySchema}. */
export type BatchEntry = z.output<typeof BatchEntrySchema>;
/** `<out>/manifest.json` of a batch; see {@link BatchManifestSchema}. */
export type BatchManifest = z.output<typeof BatchManifestSchema>;
/** `frame` params. */
export type FrameParams = MethodParams<"frame">;
/** Result of `frame`. */
export type FrameResult = MethodResult<"frame">;
/** One format as `format.list` reports it. */
export type FormatInfo = z.output<typeof FormatInfoSchema>;
/** Result of `format.add` and `format.remove`; see {@link FormatChangeSchema}. */
export interface FormatChange {
  dir: string;
  formats: FormatInfo[];
  op: string;
  tx: string;
  undo: { method: "format.add" | "format.remove"; params: Record<string, unknown> };
  proposal: string | null;
}
/** Result of `style.set` and `style.apply`; see {@link StyleChangeSchema}. */
export interface StyleChange {
  dir: string;
  path: string;
  changes: { path: string; before: unknown; after: unknown }[];
  op: string;
  tx: string;
  proposal: string | null;
}
/** Result of `style.save`. */
export type StyleSaveResult = MethodResult<"style.save">;
/** Result of `style.list`. */
export type StyleListResult = MethodResult<"style.list">;
/** `cover` params. */
export type CoverParams = MethodParams<"cover">;
/** Result of `cover`. */
export type CoverResult = MethodResult<"cover">;
/** `analyze` params. */
export type AnalyzeParams = MethodParams<"analyze">;
/** Result of `analyze`. */
export type AnalyzeResult = MethodResult<"analyze">;
/** `analyze.diff` params. */
export type AnalyzeDiffParams = MethodParams<"analyze.diff">;
/** Result of `analyze.diff`. */
export type AnalyzeDiffResult = MethodResult<"analyze.diff">;
/** `review` params. */
export type ReviewParams = MethodParams<"review">;
/** Result of `review`. */
export type ReviewResult = MethodResult<"review">;
/** Image format `frame` writes; see {@link FrameFormatSchema}. */
export type FrameFormat = z.output<typeof FrameFormatSchema>;
/** One export preset as listed by `export.presets`. */
export type ExportPresetInfo = z.output<typeof ExportPresetResultSchema>;
/** `file.write` params. */
export type FileWriteParams = MethodParams<"file.write">;
/** Result of `file.write`. */
export type FileWriteResult = MethodResult<"file.write">;
/** Background job as reported by `status` and `job.list`. */
export type JobInfo = z.output<typeof JobSchema>;
/** Order of a queued {@link JobInfo}: see `priority` of `job.list`. */
export type JobPriority = JobInfo["priority"];
/** Step of a running {@link JobInfo}. */
export type JobStep = NonNullable<JobInfo["step"]>;
/** Result of `clip.renders`. */
export type ClipRendersResult = MethodResult<"clip.renders">;
/** `clip.live` params. */
export type ClipLiveParams = MethodParams<"clip.live">;
/** Result of `clip.live`. */
export type ClipLiveResult = MethodResult<"clip.live">;
/** `clip.verify` params. */
export type ClipVerifyParams = MethodParams<"clip.verify">;
/** Result of `clip.verify`. */
export type ClipVerifyResult = MethodResult<"clip.verify">;
/** Render cache state of one generated clip, as `clip.renders` reports it. */
export type ClipRenderInfo = z.output<typeof ClipRenderSchema>;
/** One entry of `audio.bakes`. */
export type AudioBakeInfo = z.output<typeof AudioBakeSchema>;
/** Result of `audio.bakes`. */
export type AudioBakesResult = MethodResult<"audio.bakes">;
/** One entry of `matte.status`. */
export type MatteStateInfo = z.output<typeof MatteStateSchema>;
/** Result of `matte.status`. */
export type MatteStatusResult = MethodResult<"matte.status">;
/** ffprobe summary of an asset. */
export type MediaProbe = z.output<typeof ProbeSchema>;
/** One asset as reported by `asset.list`. */
export type AssetInfo = z.output<typeof AssetSchema>;
/** `asset.import` params. */
export type AssetImportParams = MethodParams<"asset.import">;
/** Result of `asset.import`. */
export type AssetImportResult = MethodResult<"asset.import">;
/** `credits.set` params. */
export type CreditsSetParams = MethodParams<"credits.set">;
/** Result of `credits.set`. */
export type CreditsSetResult = MethodResult<"credits.set">;
/** `credits.check` params. */
export type CreditsCheckParams = MethodParams<"credits.check">;
/** Result of `credits.check`. */
export type CreditsCheckResult = MethodResult<"credits.check">;
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
  /** data: `{ path, details }` of the global `config.json` or the model registry `models.json` */
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
  /** data: `{ clip, type, timeline, details }`: the clip cannot be shown live (no adapter, adapter without `livePreview`, or it failed). */
  LiveUnavailable: -32039,
  /** data: `{ op, feature, hint }`: valid request this version cannot carry out yet, e.g. `clip.add` on a program track. */
  Unsupported: -32040,
  /**
   * data: `{ tx, label, author, state, hint }`: review mode (ADR 0019) holds a proposal of another author, or yours is
   * ready: run `proposal.wait`, then continue.
   */
  ProposalPending: -32041,
  /**
   * data: `{ tx, reason, conflicts, hint }`; reason `forbidden` (only `ui` decides proposals or sets review mode),
   * `building`, `decided`, `unknown` (no such open proposal), `stale` or `rejected` (your proposal closed unapplied).
   */
  ProposalState: -32042,
  /**
   * data: `{ id, reason, file?, hint }`; reason `unknown` (the model is not registered on this machine and the
   * provider does not ship it), `missing-file` (its registered file is gone) or `format` (its format is not one
   * the provider reads). `hint` says how to register it.
   */
  ModelNotRegistered: -32043,
  /** data: `{ file, reason }`: the file is not a ggml, gguf or ONNX model, or is pickle-based (it could run code). */
  UnsupportedModelFormat: -32044,
  /** data: `{ format, available: string[] }`: the project has no such format (ADR 0027); `available` lists its formats. */
  FormatNotFound: -32045,
  /** data: `{ provider, available: string[] }`: no built-in or loaded plugin speech provider has this id (ADR 0034). */
  SpeechProviderNotFound: -32046,
  /** data: `{ provider, line, details, written: string[] }`: the provider failed on line `line`; `written` lists the takes kept. */
  SpeechFailed: -32047,
  /**
   * data: `{ provider, voice, lines: string[], cost: { amount, currency } | null, characters, confirmation }`: a paid generation
   * waits for the person to confirm its cost; call again with `yes` (CLI `--yes`) and the `confirmation` token only once they did.
   */
  ConfirmationRequired: -32048,
  /**
   * data: same as `ConfirmationRequired` (the current ask, with its new `confirmation`) plus `hint`: the call carried the
   * `confirmation` of an earlier ask, but the lines to say or their cost changed since, so nothing was generated.
   */
  ConfirmationStale: -32049,
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
