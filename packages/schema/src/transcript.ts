import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `transcripts/*.words.json`. */
export const TRANSCRIPT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/transcript.json`;

/** Stable word id, e.g. `w_000001`. Opaque: never reorder or reuse. */
export const WordIdSchema = z.string().regex(/^w_\d{6,}$/, "must look like `w_000001`");

/** Speaker id in a transcript, e.g. `s1`. Opaque and stable across re-runs of `transcribe.speakers`. */
export const SpeakerIdSchema = z.string().regex(/^s\d+$/, "must look like `s1`");

/** Number part of a {@link WordIdSchema} id (`w_000042` → 42). */
export function wordIdNumber(id: string): number {
  return Number(id.slice(2));
}

const WordSchema = z
  .strictObject({
    id: WordIdSchema,
    text: z.string(),
    /** Source-asset seconds. For whisper.cpp: DTW onset (ADR 0003). */
    start: z.number().nonnegative(),
    /** Source-asset seconds. For whisper.cpp: derived from audio energy, DTW has no end (ADR 0003). */
    end: z.number().nonnegative(),
    /** 0..1 */
    confidence: z.number().min(0).max(1).optional(),
    /**
     * True: the span lasts far longer than a word and holds more speech the
     * engine could not split into words (e.g. a repeated phrase swallowed).
     * Never cut inside it. Written by `transcribe` only when true.
     */
    speechInside: z.boolean().optional(),
    /** Who says it (ADR 0016): a `speakers` id, set by speaker diarization. A human correction goes in `edits`. */
    speaker: SpeakerIdSchema.optional(),
  })
  .refine((word) => word.end >= word.start, { message: "end must be >= start", path: ["end"] });

/** Human correction of one word: its text, who says it, or both. Wins over the transcribed values. */
const WordEditSchema = z
  .strictObject({ text: z.string().optional(), speaker: SpeakerIdSchema.optional() })
  .refine((edit) => edit.text !== undefined || edit.speaker !== undefined, { message: "an edit sets `text`, `speaker` or both" });

/** One person speaking in a transcript. `name` is free text a human may change; `id` stays. */
const SpeakerSchema = z.strictObject({ id: SpeakerIdSchema, name: z.string().min(1) });

/**
 * Zod model of a word-level transcript (SPEC §5.4). Times are source-asset
 * seconds measured on the CFR proxy. `edits` holds human corrections keyed by
 * word id; re-transcribing keeps those whose id survives. `speakers` lists who
 * speaks (speaker diarization); every word or edit `speaker` names one of them.
 */
export const TranscriptSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Project-relative, `/`-separated. */
    asset: z.string().min(1),
    /** `sha256:<hex>` of the asset bytes; a mismatch means the transcript is stale. */
    assetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be `sha256:` + 64 lowercase hex digits"),
    provider: z.string().min(1),
    model: z.string().min(1),
    language: z.string().optional(),
    words: z.array(WordSchema),
    edits: z.record(WordIdSchema, WordEditSchema).default({}),
    /**
     * Number of the next word id to hand out (`5` → `w_000005`). Every id
     * below it was used once, maybe by a word a later run dropped, so it is
     * never handed out again. Written by the daemon, never lowered. Absent
     * (hand-written file): ids above every word and edit id are free.
     */
    nextWordId: z.number().int().positive().optional(),
    /** Who speaks, in order of first appearance. Absent: speakers were never diarized. */
    speakers: z.array(SpeakerSchema).optional(),
  })
  .superRefine((transcript, ctx) => {
    const speakers = new Set<string>();
    transcript.speakers?.forEach((speaker, index) => {
      if (speakers.has(speaker.id)) ctx.addIssue({ code: "custom", message: `duplicate speaker id ${speaker.id}`, path: ["speakers", index, "id"] });
      speakers.add(speaker.id);
    });
    const unlisted = (id: string) => `speaker ${id} is not in \`speakers\`${speakers.size > 0 ? ` (${[...speakers].join(", ")})` : ""}`;
    transcript.words.forEach((word, index) => {
      if (word.speaker !== undefined && !speakers.has(word.speaker)) ctx.addIssue({ code: "custom", message: unlisted(word.speaker), path: ["words", index, "speaker"] });
    });
    for (const [id, edit] of Object.entries(transcript.edits)) {
      if (edit.speaker !== undefined && !speakers.has(edit.speaker)) ctx.addIssue({ code: "custom", message: unlisted(edit.speaker), path: ["edits", id, "speaker"] });
    }
    const seen = new Set<string>();
    const next = transcript.nextWordId;
    transcript.words.forEach((word, index) => {
      if (seen.has(word.id)) ctx.addIssue({ code: "custom", message: `duplicate word id ${word.id}`, path: ["words", index, "id"] });
      seen.add(word.id);
      if (next !== undefined && wordIdNumber(word.id) >= next) {
        ctx.addIssue({ code: "custom", message: `word id ${word.id} is not below nextWordId ${next}`, path: ["words", index, "id"] });
      }
    });
    if (next === undefined) return;
    for (const id of Object.keys(transcript.edits)) {
      if (wordIdNumber(id) >= next) ctx.addIssue({ code: "custom", message: `edit id ${id} is not below nextWordId ${next}`, path: ["edits", id] });
    }
  });

/** Validated transcript file content. */
export type Transcript = z.infer<typeof TranscriptSchema>;

/** One word of a {@link Transcript}. */
export type TranscriptFileWord = Transcript["words"][number];

/** One speaker of a {@link Transcript}. */
export type TranscriptSpeaker = NonNullable<Transcript["speakers"]>[number];

/** Who says `word`: the human correction in `edits`, else the diarized speaker; undefined when unknown. */
export function wordSpeaker(transcript: Pick<Transcript, "edits">, word: Pick<TranscriptFileWord, "id" | "speaker">): string | undefined {
  return transcript.edits[word.id]?.speaker ?? word.speaker;
}

/** Validate unknown input as a transcript. Never throws. */
export function parseTranscript(input: unknown): ParseResult<Transcript> {
  const result = TranscriptSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
