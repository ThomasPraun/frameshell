// The misread round trip of `voiceover.generate` (ADR 0034 decisions 13 and 18): each take goes through the
// project's transcription provider and its words are compared with the line's spoken text by `compareTake`, the
// shoot comparison, so word normalization and spoken numbers stay in `packages/schema/src/spoken.ts` (one source).
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import type { Progress, VoiceoverGenerateResult } from "@frameshell/protocol";
import type { ShootScript } from "@frameshell/schema";
import { type HeardWord, compareTake } from "../shoot/compare.js";
import { type AudioExtractor, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "../transcripts/audio.js";
import { type TranscriberTools, providerContext } from "../transcripts/transcriber.js";
import { VERIFY_CACHE_DIR } from "../transcripts/verify.js";
import { type Pcm16, pcmWavBytes } from "../transcripts/window.js";

/** What the round trip found for one line: the `check` of a `voiceover.generate` line. */
export type LineCheck = NonNullable<VoiceoverGenerateResult["lines"][number]["check"]>;
/** How the round trip went as a whole: the `verification` of a `voiceover.generate` result. */
export type Verification = VoiceoverGenerateResult["verification"];

/** One take to check. */
export interface TakeToCheck {
  id: string;
  /** What the voice was asked to read. */
  spoken: string;
  /** The line as captions show it: a respelled word is written here as people spell it. */
  display: string;
  /** The take, absolute (read by ffmpeg when its sample rate is not the provider's). */
  file: string;
  pcm: Pcm16;
}

/** Input of {@link verifyTakes}. */
export interface VerifyRequest {
  /** Project root: the temporary audio goes under {@link VERIFY_CACHE_DIR}. */
  root: string;
  takes: readonly TakeToCheck[];
  /** The voice's language (`es`, `en-US`…); null = the provider's default or detection. */
  language: string | null;
  providerId: string;
  /** Loads the provider; rejects when the project cannot (untrusted, plugin missing). */
  provider(): Promise<TranscriptionProvider>;
  model?: string | undefined;
  tools: TranscriberTools;
  /** Defaults to ffmpeg via `tools`. */
  extractAudio?: AudioExtractor | undefined;
  progress(update: Progress): void;
  signal: AbortSignal;
}

/** Result of {@link verifyTakes}. */
export interface VerifyOutcome {
  verification: Verification;
  /** By take id; absent for takes not checked. */
  checks: Map<string, { check: LineCheck; words: readonly TranscriptWord[] }>;
  warnings: string[];
}

/**
 * Round-trip `request.takes` through speech-to-text. A provider that cannot be had or fails never fails the
 * call: generation may have been paid for, so the outcome says `skipped` and why (an untrusted project, no
 * transcription plugin, a failed run) and the takes stay as they are. Only an abort throws.
 */
export async function verifyTakes(request: VerifyRequest): Promise<VerifyOutcome> {
  const checks: VerifyOutcome["checks"] = new Map();
  const warnings: string[] = [];
  const skipped = (reason: string): VerifyOutcome => ({
    verification: { status: "skipped", provider: request.providerId, model: request.model ?? null, reason, misread: 0, doubtful: 0 },
    checks,
    warnings,
  });
  let provider: TranscriptionProvider;
  try {
    provider = await request.provider();
  } catch (error) {
    return skipped(`Verification skipped: ${reasonOf(error)}`);
  }

  const { context } = providerContext(request.tools, request.progress);
  const extractAudio = request.extractAudio ?? extractAudioWithFfmpeg;
  const language = request.language?.split(/[-_]/)[0]?.toLowerCase();
  const options = { ...(request.model ? { model: request.model } : {}), ...(language ? { language } : {}) };
  let model = request.model ?? null;
  let failure: string | null = null;
  for (const [index, take] of request.takes.entries()) {
    request.signal.throwIfAborted();
    request.progress({ message: `Checking ${take.id} (${index + 1}/${request.takes.length})`, fraction: index / request.takes.length, stage: "verify", values: { line: take.id } });
    const audio = join(request.root, ...VERIFY_CACHE_DIR.split("/"), `${randomBytes(6).toString("hex")}.wav`);
    try {
      await mkdir(dirname(audio), { recursive: true });
      if (take.pcm.sampleRate === TRANSCRIPTION_SAMPLE_RATE) await writeFile(audio, pcmWavBytes(take.pcm));
      else await extractAudio({ path: take.file }, audio, () => request.tools.ensureBinary("ffmpeg", request.progress));
      const result = await provider.transcribe(audio, options, context);
      model = result.model;
      for (const note of result.notes ?? []) warnings.push(`Line ${take.id}: ${note}`);
      checks.set(take.id, { check: checkLine(take.spoken, take.display, result.words, request.language), words: result.words });
    } catch (error) {
      if (request.signal.aborted) throw error;
      failure = `Verification stopped at line ${take.id}: ${reasonOf(error)}`;
      break;
    } finally {
      await rm(audio, { force: true });
    }
  }
  if (failure !== null) {
    if (checks.size === 0) return skipped(failure);
    warnings.push(failure);
  }
  const all = [...checks.values()];
  return {
    verification: {
      status: "checked",
      provider: request.providerId,
      model,
      reason: null,
      misread: all.filter(({ check }) => check.status === "misread").length,
      doubtful: all.filter(({ check }) => check.status === "doubtful").length,
    },
    checks,
    warnings,
  };
}

const RANK = { clean: 0, doubtful: 1, misread: 2 } as const;

/**
 * Compare what a take was heard to say with the line it was asked to read: the shoot comparison over a one-line
 * script. A line is `clean` with no difference, `doubtful` when every difference may be the transcription's (a
 * number, a close spelling), `misread` otherwise. Times are take seconds. A transcription writes a respelled name
 * as people spell it (`freim shel` is heard as `Frameshell`), so the line is also compared as `display` and the
 * better match wins; the differences reported are those of that comparison.
 */
export function checkLine(spoken: string, display: string, heard: readonly TranscriptWord[], language: string | null): LineCheck {
  const asSpoken = compareLine(spoken, heard, language);
  if (display === spoken || asSpoken.status === "clean") return asSpoken;
  const asDisplay = compareLine(display, heard, language);
  const better = RANK[asDisplay.status] - RANK[asSpoken.status] || size(asDisplay) - size(asSpoken);
  return better < 0 ? asDisplay : asSpoken;
}

/** Words of the line the differences cover: a line barely matched at all counts whole, so the narrower reading wins. */
function size(check: LineCheck): number {
  return check.misreads.reduce((total, misread) => total + misread.expected.split(/\s+/).length, 0);
}

function compareLine(spoken: string, heard: readonly TranscriptWord[], language: string | null): LineCheck {
  const words = spoken.split(/\s+/).filter((word) => word !== "");
  const script: ShootScript = {
    meta: { title: null, targetDuration: null, aspect: null },
    shoot: { shoot: true, source: null, sourceHash: null, follow: "words" },
    scenes: [{ title: "line", slug: "line", line: 1, endLine: 1, expected: null, words: words.length, lines: [{ line: 1, speaker: null, text: spoken, words, cues: [] }] }],
    speakers: [],
    warnings: [],
  };
  const timed: HeardWord[] = heard.map((word) => ({ text: word.text, start: word.start, end: word.end, speaker: null }));
  const heardText = heard.map((word) => word.text).join(" ");
  const comparison = compareTake(script, timed, language);
  // Too little matched to count the line as said: the whole line is the difference.
  if (comparison.lines.every((line) => line.status === "outside")) {
    const at = heard.length > 0 ? { start: heard[0]!.start, end: heard.at(-1)!.end } : null;
    return { status: "misread", heard: heardText, misreads: [{ kind: heard.length > 0 ? "changed" : "missing", expected: spoken, heard: heardText, at, maybeTranscription: false }] };
  }
  const misreads = comparison.deviations.flatMap((deviation) =>
    deviation.kind === "free" || deviation.kind === "speaker" || deviation.kind === "length"
      ? []
      : [{ kind: deviation.kind, expected: deviation.expected, heard: deviation.heard, at: deviation.at, maybeTranscription: deviation.maybeTranscription }],
  );
  const status = misreads.length === 0 ? "clean" : misreads.every((misread) => misread.maybeTranscription) ? "doubtful" : "misread";
  return { status, heard: heardText, misreads };
}

/** The heard words whose middle falls in each range, joined; "" for a range nothing was heard in. */
export function textInRanges(ranges: readonly { from: number; to: number }[], words: readonly TranscriptWord[]): string[] {
  return ranges.map(({ from, to }) =>
    words
      .filter((word) => {
        const middle = (word.start + word.end) / 2;
        return middle >= from && middle < to;
      })
      .map((word) => word.text)
      .join(" "),
  );
}

function reasonOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
