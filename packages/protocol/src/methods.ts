import { z } from "zod";
import { ProposalConfigChangeSchema } from "./config.js";
import { ProposalStateSchema } from "./proposals.js";
import { ShootChangedSchema } from "./shoot.js";
import { TargetChangedSchema } from "./targets.js";
import { PeopleChangedSchema } from "./people.js";
import { OperationResultSchema, TimelineRejectionSchema } from "./timeline.js";
import { UiCommandSchema, UiViewIdSchema } from "./ui.js";
import {
  type MethodSpec,
  IdempotencyKeySchema,
  ProjectSummarySchema,
  BinaryReportSchema,
  CodecReportSchema,
  EncoderNameSchema,
  QualityTierSchema,
  EncoderReportSchema,
  MachineProfileSchema,
  TrustStateSchema,
  GcEntrySchema,
  GcSkipSchema,
  PluginInfoSchema,
  JobSchema,
  AudioBakeSchema,
  MatteStateSchema,
  ClipFinalRenderSchema,
  ClipRenderSchema,
  ProbeSchema,
  AssetSchema,
  EventNameSchema,
  ExportPresetResultSchema,
  FrameFormatSchema,
  FormatInfoSchema,
  BatchEntrySchema,
  BatchManifestSchema,
  BatchReviewSchema,
  LostWordSchema,
  UncertainWordSchema,
} from "./methods/shared.js";
import { connectionMethods } from "./methods/connection.js";
import { exportMethods } from "./methods/export.js";
import { assetMethods } from "./methods/assets.js";
import { jobMethods } from "./methods/jobs.js";
import { transcriptMethods } from "./methods/transcripts.js";
import { channelMethods } from "./methods/channels.js";
import { scriptSoundMethods } from "./methods/script-sound.js";
import { shootMethods } from "./methods/shoot.js";
import { timelineMethods } from "./methods/timeline.js";
import { clipMethods } from "./methods/clips.js";
import { cleanupMusicMethods } from "./methods/cleanup-music.js";
import { historyMethods } from "./methods/history.js";
import { styleMethods } from "./methods/style.js";
import { peopleMethods } from "./methods/people.js";
import { uiMethods } from "./methods/ui.js";

/**
 * Wire protocol version. Client and daemon must match exactly; bump on any
 * breaking change to a method, param, result or error code.
 */
export const PROTOCOL_VERSION = 173;

export {
  type MethodSpec,
  IdempotencyKeySchema,
  PROPOSAL_WAIT_DEFAULT_S,
  PROPOSAL_WAIT_MAX_S,
  DEFAULT_FRAME_QUALITY,
  COVER_MAX_CHARS,
  BatchManifestSchema,
} from "./methods/shared.js";
export { AUDIO_INSPECT_MAX } from "./methods/script-sound.js";

const merged = {
  ...connectionMethods,
  ...exportMethods,
  ...assetMethods,
  ...jobMethods,
  ...transcriptMethods,
  ...channelMethods,
  ...scriptSoundMethods,
  ...shootMethods,
  ...timelineMethods,
  ...clipMethods,
  ...cleanupMusicMethods,
  ...historyMethods,
  ...styleMethods,
  ...peopleMethods,
  ...uiMethods,
};

/**
 * Every method frameshelld serves: the single source for client and daemon
 * types, daemon param validation and generated tool schemas.
 * Entries live in one module per area under `methods/`, spread into `merged` in order (the order of
 * {@link methodJsonSchemas}). Adding a method = one entry in its area module plus its daemon
 * handler (the compiler enforces the handler); a new area module also joins {@link MethodRegistry}.
 */
export const methods: MethodRegistry = merged;

// Spread members skip excess-property checks: fails to compile when an area is spread into `merged` but
// missing from MethodRegistry, or the reverse (its methods would lack a type, so lack a daemon handler).
type MustBeTrue<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _AreasMatch = MustBeTrue<SameKeys<keyof typeof merged, keyof MethodRegistry>>;

/**
 * Type of {@link methods}, one area module per base. Declared rather than inferred so the emitted
 * declaration names the area modules instead of printing every schema (TS7056 limit).
 */
export interface MethodRegistry
  extends ConnectionMethods,
    ExportMethods,
    AssetMethods,
    JobMethods,
    TranscriptMethods,
    ChannelMethods,
    ScriptSoundMethods,
    ShootMethods,
    TimelineMethods,
    ClipMethods,
    CleanupMusicMethods,
    HistoryMethods,
    StyleMethods,
    PeopleMethods,
    UiMethods {}

type ConnectionMethods = typeof connectionMethods;
type ExportMethods = typeof exportMethods;
type AssetMethods = typeof assetMethods;
type JobMethods = typeof jobMethods;
type TranscriptMethods = typeof transcriptMethods;
type ChannelMethods = typeof channelMethods;
type ScriptSoundMethods = typeof scriptSoundMethods;
type ShootMethods = typeof shootMethods;
type TimelineMethods = typeof timelineMethods;
type ClipMethods = typeof clipMethods;
type CleanupMusicMethods = typeof cleanupMusicMethods;
type HistoryMethods = typeof historyMethods;
type StyleMethods = typeof styleMethods;
type PeopleMethods = typeof peopleMethods;
type UiMethods = typeof uiMethods;

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
/** Result of `audio.inspect`. */
export type AudioInspectResult = MethodResult<"audio.inspect">;

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
/** Result of `batch.cancel`. */
export type BatchCancelResult = MethodResult<"batch.cancel">;
/** One row × format of a batch; see {@link BatchEntrySchema}. */
export type BatchEntry = z.output<typeof BatchEntrySchema>;
/** What `review` found on one rendered row; see {@link BatchReviewSchema}. */
export type BatchReview = z.output<typeof BatchReviewSchema>;
/** `<out>/manifest.json` of a batch; see {@link BatchManifestSchema}. */
export type BatchManifest = z.output<typeof BatchManifestSchema>;
/** `frame` params. */
export type FrameParams = MethodParams<"frame">;
/** Result of `frame`. */
export type FrameResult = MethodResult<"frame">;
/** One format as `format.list` reports it. */
export type FormatInfo = z.output<typeof FormatInfoSchema>;
/** Result of `format.add` and `format.remove`; schema `FormatChangeSchema` in `methods/shared.ts`. */
export interface FormatChange {
  dir: string;
  formats: FormatInfo[];
  op: string;
  tx: string;
  undo: { method: "format.add" | "format.remove"; params: Record<string, unknown> };
  proposal: string | null;
}
/** Result of `style.set` and `style.apply`; schema `StyleChangeSchema` in `methods/shared.ts`. */
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
/** `clip.compare` params. */
export type ClipCompareParams = MethodParams<"clip.compare">;
/** Result of `clip.compare`. */
export type ClipCompareResult = MethodResult<"clip.compare">;
/** `clip.verify` params. */
export type ClipVerifyParams = MethodParams<"clip.verify">;
/** Result of `clip.verify`. */
export type ClipVerifyResult = MethodResult<"clip.verify">;
/** `grade.analyze` params. */
export type GradeAnalyzeParams = MethodParams<"grade.analyze">;
/** Result of `grade.analyze`. */
export type GradeAnalyzeResult = MethodResult<"grade.analyze">;
/** `grade.compare` params. */
export type GradeCompareParams = MethodParams<"grade.compare">;
/** Result of `grade.compare`. */
export type GradeCompareResult = MethodResult<"grade.compare">;
/** Render cache state of one generated clip, as `clip.renders` reports it. */
export type ClipRenderInfo = z.output<typeof ClipRenderSchema>;
/** The final render of a generated clip that keeps two, as `clip.renders` reports it (ADR 0041). */
export type ClipFinalRenderInfo = z.output<typeof ClipFinalRenderSchema>;
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
   * Something waits for the person to confirm it; call again with `yes` (CLI `--yes`) only once they did. `voiceover.generate`
   * data: `{ provider, voice, lines: string[], cost: { amount, currency } | null, characters, confirmation }`, a paid generation
   * (pass the `confirmation` token too). `render` data: `{ finals: { clip, type, format, seconds }[], seconds, limit, hint }`,
   * final renders of generated clips estimated over `limit` seconds in all (`seconds` null when a plugin could not say).
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
