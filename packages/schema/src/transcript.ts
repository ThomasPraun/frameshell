import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `transcripts/*.words.json`. */
export const TRANSCRIPT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/transcript.json`;

/** Stable word id, e.g. `w_000001`. Opaque: never reorder or reuse. */
export const WordIdSchema = z.string().regex(/^w_\d{6,}$/, "must look like `w_000001`");

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
  })
  .superRefine((transcript, ctx) => {
    const seen = new Set<string>();
    transcript.words.forEach((word, index) => {
      if (seen.has(word.id)) ctx.addIssue({ code: "custom", message: `duplicate word id ${word.id}`, path: ["words", index, "id"] });
      seen.add(word.id);
    });
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
