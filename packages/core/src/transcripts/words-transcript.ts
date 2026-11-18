import type { TranscriptWord } from "@frameshell/plugin-api";
import { SCHEMA_VERSION, TRANSCRIPT_SCHEMA_URL, type Transcript, parseTranscript } from "@frameshell/schema";
import { assignWordIds } from "./ids.js";
import { readPrevious, resolveTranscript } from "./transcriber.js";

/** Who timed the words of a transcript that `transcribe` did not write. */
export interface WordsTranscriptSource {
  /** `sha256:<hex>` of the asset. */
  assetHash: string;
  provider: string;
  model: string;
  language: string | null;
}

/** A transcript built by {@link transcriptFromWords}, not written yet. */
export interface BuiltTranscript {
  /** Project-relative transcript file. */
  rel: string;
  /** Absolute path to write it to. */
  path: string;
  transcript: Transcript;
}

/**
 * The transcript of `asset` (SPEC §5.4) made of `words` already timed on the asset's clock, in time order, for the
 * callers that time words themselves (shoot session takes, voiceover captions). Word ids and their human edits are
 * kept from the transcript already there, as `transcribe` keeps them. Throws when the words make no valid transcript,
 * and what {@link resolveTranscript} throws.
 */
export async function transcriptFromWords(root: string, asset: string, words: readonly TranscriptWord[], source: WordsTranscriptSource): Promise<BuiltTranscript> {
  const { rel, path } = await resolveTranscript(root, asset);
  const previous = await readPrevious(path);
  const assigned = assignWordIds(
    words.map((word) => ({ ...word, end: Math.max(word.start, word.end) })),
    previous,
  );
  const transcript: Transcript = {
    $schema: TRANSCRIPT_SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    asset,
    assetHash: source.assetHash,
    provider: source.provider,
    model: source.model,
    ...(source.language ? { language: source.language } : {}),
    words: assigned.words,
    edits: assigned.edits,
    nextWordId: assigned.nextWordId,
  };
  const checked = parseTranscript(transcript);
  if (!checked.ok) throw new Error(`the words of ${asset} do not make a valid transcript:\n${checked.error}`);
  return { rel, path, transcript };
}
