import { z } from "zod";
import { ModelIdSchema, ModelListResultSchema, RegisteredModelSchema } from "../models.js";
import { TimelineIdSchema } from "../timeline.js";
import { type MethodSpec, AbsolutePath, CwdParam, LostWordSchema, UncertainWordSchema } from "./shared.js";

/** Daemon methods: transcription and transcription models. */
export const transcriptMethods = {
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
} as const satisfies Record<string, MethodSpec>;
