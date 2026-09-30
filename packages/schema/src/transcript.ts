import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `transcripts/*.words.json`. */
export const TRANSCRIPT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/transcript.json`;

/** Stable word id, e.g. `w_000001`. Opaque: never reorder or reuse. */
export const WordIdSchema = z.string().regex(/^w_\d{6,}$/, "must look like `w_000001`");

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
  })
  .refine((word) => word.end >= word.start, { message: "end must be >= start", path: ["end"] });

/** Human correction of one word. Only `text` for now. */
const WordEditSchema = z.strictObject({ text: z.string() });

/**
 * Zod model of a word-level transcript (SPEC §5.4). Times are source-asset
 * seconds measured on the CFR proxy. `edits` holds human corrections keyed by
 * word id; re-transcribing keeps those whose id survives.
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
  })
  .superRefine((transcript, ctx) => {
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

/** Validate unknown input as a transcript. Never throws. */
export function parseTranscript(input: unknown): ParseResult<Transcript> {
  const result = TranscriptSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
