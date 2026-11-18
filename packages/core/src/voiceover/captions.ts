// `voiceover.captions` (ADR 0034 decision 23): the display form of each line, timed by the words heard in its take
// (`alignWords`, the transcript aligner, over the words the voice said: numbers spelled by `spokenTokens`) or spread
// over the take's phrases by length when nothing was heard. The words become the take's transcript, which a subtitle
// track following the voice track shows; one caption phrase per take phrase chunks them (`captions.set`, no other writer).
import { join } from "node:path";
import type { TranscriptWord } from "@frameshell/plugin-api";
import { ErrorCode, type Progress, RpcError, type ValidatedParams, type VoiceoverCaptionsResult } from "@frameshell/protocol";
import { type CaptionPhrase, type NumberLanguage, type Track, numberLanguage, resolveSubtitleStyle, spokenTokens } from "@frameshell/schema";
import type { StepResult } from "../sound/place.js";
import { type TimedWord, alignWords } from "../transcripts/align.js";
import { resolveTranscript } from "../transcripts/transcriber.js";
import { type BuiltTranscript, transcriptFromWords } from "../transcripts/words-transcript.js";
import type { VerifyServices } from "./generate.js";
import { type LoadedTimeline, VOICE_TRACK_NAME } from "./place.js";
import { pickLines, readVoiceoverScript } from "./script.js";
import type { Phrase } from "./split.js";
import { readLineTakes } from "./takes.js";
import { verifyTakes } from "./verify.js";

/** Params of `voiceover.captions`. */
export type VoiceoverCaptionsParams = ValidatedParams<"voiceover.captions">;

/** Name of the subtitle track the captions go on when the voice track has none. */
export const VOICE_CAPTIONS_TRACK_NAME = "Voiceover captions";

/** `provider` and `model` of a take transcript whose words were spread over the phrases, not heard. */
export const SCRIPT_TIMING = { provider: "voiceover-script", model: "proportional" } as const;

/** Most words and characters one cue may hold: the subtitle track style's `maxWords`/`maxChars`. */
export interface CaptionLimits {
  /** Most words one cue holds. */
  maxWords: number;
  /** Most characters one cue holds, spaces included, unless it is a single word. */
  maxChars: number;
}

/** One line to caption: its display text and its take. */
export interface CaptionLineInput {
  /** The line as captions show it (`VoiceoverLine.display`). */
  display: string;
  /** The take cut at its silences, take seconds. */
  phrases: readonly Phrase[];
  /** Words heard in the take, take seconds; null when it was not transcribed. */
  heard: readonly TimedWord[] | null;
}

/** A line's display words on the take clock, grouped by phrase. */
export interface CaptionedLine {
  /** How the words were timed: by the words heard, or spread over the phrases (`unaligned`, `proportional`). */
  timing: VoiceoverCaptionsResult["lines"][number]["timing"];
  /** Display words in order, take seconds (3 decimals). */
  words: TimedWord[];
  /** One entry per phrase holding words, in order: its words from index `first`, `chunks` words per cue. */
  phrases: { phrase: number; first: number; chunks: number[] }[];
  /** Display words not heard, timed between their neighbours. */
  missing: string[];
}

/**
 * The words captions show for `display`: split at spaces, with a token of punctuation only (`—`, `¿`) joined to the
 * word before it (the word after, at the start), so every caption word holds something that is said.
 */
export function displayWords(display: string): string[] {
  const words: string[] = [];
  let lead = "";
  for (const part of display.split(/\s+/)) {
    if (part === "") continue;
    if (!/[\p{L}\p{N}]/u.test(part)) {
      if (words.length > 0) words[words.length - 1] += ` ${part}`;
      else lead = lead === "" ? part : `${lead} ${part}`;
      continue;
    }
    words.push(lead === "" ? part : `${lead} ${part}`);
    lead = "";
  }
  return words;
}

/**
 * Word counts of the cues one phrase of `words` splits into: the fewest cues of even size (larger first) in which none
 * holds more than `maxWords` words or, unless it is one word, more than `maxChars` characters.
 */
export function chunkSizes(words: readonly string[], limits: CaptionLimits): number[] {
  const n = words.length;
  for (let count = Math.max(1, Math.ceil(n / Math.max(1, limits.maxWords))); count <= n; count++) {
    const sizes = Array.from({ length: count }, (_, i) => Math.floor(n / count) + (i < n % count ? 1 : 0));
    let at = 0;
    const fits = sizes.every((size) => {
      const chars = words.slice(at, at + size).join(" ").length;
      at += size;
      return size === 1 || chars <= limits.maxChars;
    });
    if (fits) return sizes;
  }
  return [];
}

/**
 * Time the display words of one line on its take (pure). With `heard`, each display word is matched by
 * {@link alignWords} as the words it is said as (`23` as `veintitrés` in `language`), against the heard words read the
 * same way (digits the transcription wrote meet the spelled number), in their time slots: a word takes the span of every heard word it covers (a number said in three words spans all three); one
 * not heard is `missing` and shares the time between its neighbours. When fewer than half the words are heard as
 * written the line is `unaligned`, and with nothing heard `proportional`: the words are spread over the phrases by the
 * length of what is said. Every word then sits inside the phrase it starts in, and the words of each phrase are cut
 * into cues of at most `limits` ({@link chunkSizes}).
 */
export function captionLine(input: CaptionLineInput, language: NumberLanguage | null, limits: CaptionLimits): CaptionedLine {
  const texts = displayWords(input.display);
  const phrases = input.phrases.length > 0 ? input.phrases : [{ from: 0, to: 0 }];
  const said = texts.map((text) => spokenTokens(text, language));
  const weights = said.map((tokens) => Math.max(1, tokens.join("").length));
  const spread = spreadOver(weights, phrases);

  let timing: CaptionedLine["timing"] = input.heard === null ? "proportional" : "heard";
  let spans: ({ start: number; end: number } | null)[] = spread;
  const missing: string[] = [];
  if (input.heard !== null) {
    const heard = [...input.heard].sort((a, b) => a.start - b.start);
    const expected = texts.map((text, i) => ({ text: said[i]!.join(" ") || text, start: spread[i]!.start, end: spread[i]!.end }));
    // One entry per heard word, so the indexes `alignWords` returns still name `heard`.
    const heardSaid = heard.map((word) => ({ ...word, text: spokenTokens(word.text, language).join(" ") || word.text }));
    const hearing = alignWords(expected, heardSaid);
    if (hearing.filter((found) => found.status === "heard").length * 2 < texts.length) {
      timing = "unaligned";
    } else {
      spans = hearing.map((found) => {
        if (found.status === "missing" || found.heard.length === 0) return null;
        return { start: Math.min(...found.heard.map((x) => heard[x]!.start)), end: Math.max(...found.heard.map((x) => heard[x]!.end)) };
      });
      for (const [i, span] of spans.entries()) if (span === null) missing.push(texts[i]!);
      spans = fillGaps(spans, weights, phrases);
    }
  }

  // In order and inside one phrase each: a heard word shared by two display words would otherwise overlap. Words that
  // start together (one heard token for both) split its span by weight, so neither is left without time.
  const words: TimedWord[] = [];
  const owner: number[] = [];
  for (const [i, span] of spans.entries()) {
    let start = span!.start;
    let end = span!.end;
    const previous = words.at(-1);
    if (previous) {
      if (start <= previous.start && previous.end > previous.start) {
        const shared = Math.min(previous.end, Math.max(end, previous.start));
        const split = previous.start + ((shared - previous.start) * weights[i - 1]!) / (weights[i - 1]! + weights[i]!);
        start = split;
        end = Math.max(end, previous.end);
        previous.end = split;
      } else {
        start = Math.max(start, previous.start);
        previous.end = Math.min(previous.end, start);
      }
    }
    // The phrase the word starts in, so its caption shows when it is said; a word said across a silence ends there.
    const k = Math.max(phraseOf(start, phrases), owner.at(-1) ?? 0);
    const phrase = phrases[k]!;
    start = Math.min(Math.max(start, phrase.from), phrase.to);
    end = Math.min(Math.max(end, start), phrase.to);
    words.push({ text: texts[i]!, start, end });
    owner.push(k);
  }
  for (const word of words) {
    word.start = round(word.start);
    word.end = Math.max(word.start, round(word.end));
  }

  const grouped: CaptionedLine["phrases"] = [];
  owner.forEach((k, i) => {
    if (grouped.at(-1)?.phrase !== k + 1) grouped.push({ phrase: k + 1, first: i, chunks: [] });
  });
  grouped.forEach((group, g) => {
    const last = grouped[g + 1]?.first ?? words.length;
    group.chunks = chunkSizes(texts.slice(group.first, last), limits);
  });
  return { timing, words, phrases: grouped, missing };
}

/** Each weight's share of the phrases' total length, laid end to end over them; a share is kept inside the phrase its middle falls in. */
function spreadOver(weights: readonly number[], phrases: readonly Phrase[]): { start: number; end: number }[] {
  const lengths = phrases.map((phrase) => Math.max(0, phrase.to - phrase.from));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const sum = weights.reduce((all, weight) => all + weight, 0);
  const offsets: number[] = [];
  lengths.reduce((at, length) => (offsets.push(at), at + length), 0);
  let cumulative = 0;
  return weights.map((weight) => {
    const a = (cumulative / sum) * total;
    cumulative += weight;
    const b = (cumulative / sum) * total;
    let k = 0;
    while (k < phrases.length - 1 && (a + b) / 2 >= offsets[k]! + lengths[k]!) k++;
    const from = phrases[k]!.from;
    return { start: from + clamp(a - offsets[k]!, 0, lengths[k]!), end: from + clamp(b - offsets[k]!, 0, lengths[k]!) };
  });
}

/** Spans for the words not heard: each run shares the time between the heard words around it, by weight. */
function fillGaps(spans: readonly ({ start: number; end: number } | null)[], weights: readonly number[], phrases: readonly Phrase[]): { start: number; end: number }[] {
  const out = [...spans];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const from = i > 0 ? out[i - 1]!.end : phrases[0]!.from;
    const to = Math.max(from, j < out.length ? out[j]!.start : phrases.at(-1)!.to);
    const run = weights.slice(i, j);
    const sum = run.reduce((all, weight) => all + weight, 0);
    let at = from;
    for (let k = i; k < j; k++) {
      const end = at + ((to - from) * weights[k]!) / sum;
      out[k] = { start: at, end };
      at = end;
    }
    i = j;
  }
  return out as { start: number; end: number }[];
}

/** Index of the phrase holding `time`, else the nearest one. */
function phraseOf(time: number, phrases: readonly Phrase[]): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  phrases.forEach((phrase, k) => {
    const away = time < phrase.from ? phrase.from - time : time > phrase.to ? time - phrase.to : 0;
    if (away < distance) {
      best = k;
      distance = away;
    }
  });
  return best;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** What planning needs of the daemon. */
export interface CaptionsDeps {
  /** Project root. */
  root: string;
  /** The timeline as the caller sees it. */
  load(): Promise<LoadedTimeline>;
  /** The project's transcription provider, as the misread check of `voiceover.generate` uses it. */
  transcription: VerifyServices;
  /** `sha256:<hex>` of a project file. */
  hash(rel: string): Promise<string>;
  /** Reports the transcription's progress to the caller. */
  progress(update: Progress): void;
  /** Aborted when the daemon stops. */
  signal: AbortSignal;
}

/** What the transaction will do; {@link runCaptionsPlan} writes it after the daemon wrote `transcripts`. */
export interface CaptionsPlan {
  /** Timeline id. */
  timeline: string;
  /** Revision the plan read; the transaction fails when the timeline moved on. */
  revision: number;
  /** Transaction label. */
  label: string;
  /** Script file, project-relative. */
  script: string;
  /** The subtitle track the captions go on; `id` null when the transaction makes it. */
  track: VoiceoverCaptionsResult["track"];
  /** Every phrase the subtitle track keeps: its phrases on other assets, then one per phrase of each take. */
  phrases: CaptionPhrase[];
  /** The take transcripts to write first. */
  transcripts: BuiltTranscript[];
  /** How the takes were timed as a whole. */
  timing: VoiceoverCaptionsResult["timing"];
  /** Report of each line, in script order. */
  lines: VoiceoverCaptionsResult["lines"];
  /** Problems found while planning. */
  warnings: string[];
}

function invalid(field: string, message: string, extra: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `voiceover.captions: ${field}: ${message}`, { op: "voiceover.captions", reason: message, field, ...extra });
}

type ClipTrack = Exclude<Track, { kind: "subtitles" }>;

/** Clips of `track` that play one of `files`. */
function playing(track: Track, files: ReadonlySet<string>): number {
  if (track.kind === "subtitles") return 0;
  return track.clips.filter((clip) => "asset" in clip && files.has(clip.asset)).length;
}

/**
 * Plan the call: read the script and the takes, find the voice track and the subtitle track, transcribe the takes
 * (skipped, never failed, when the project cannot), time each line's display words ({@link captionLine}) and build
 * the take transcripts and caption phrases. Writes nothing. Throws `ScriptNotFound`, `InvalidParams` (unknown line) or
 * `InvalidOperation` (no take, no take on the timeline, a `track` that is not a subtitle track of the voice).
 */
export async function planVoiceoverCaptions(params: VoiceoverCaptionsParams, deps: CaptionsDeps): Promise<CaptionsPlan> {
  const read = await readVoiceoverScript(deps.root, params.cwd, params.script, "voiceover.captions");
  const lines = pickLines(read.lines, params.lines);
  const { takes, warnings } = await readLineTakes(deps.root, read.path, lines, "voiceover.captions");
  const files = new Set(takes.map((take) => take.file));

  const { timeline } = await deps.load();
  let voice: ClipTrack | undefined;
  let subtitles: Extract<Track, { kind: "subtitles" }> | undefined;
  if (params.track !== undefined) {
    const found = timeline.tracks.find((candidate) => candidate.id === params.track);
    if (!found) throw invalid("track", `no track "${params.track}" in timeline ${timeline.id}.`, { available: timeline.tracks.map((candidate) => candidate.id) });
    if (found.kind !== "subtitles") throw invalid("track", `${found.id} is a ${found.kind} track; captions go on a subtitle track.`);
    const followed = timeline.tracks.find((candidate) => candidate.id === found.follows);
    if (!followed || followed.kind === "subtitles" || playing(followed, files) === 0) {
      throw invalid("track", `${found.id} follows ${found.follows}, which plays none of these takes: pick a subtitle track that follows the voice track, or leave \`track\` out.`);
    }
    subtitles = found;
    voice = followed;
  } else {
    const candidates = timeline.tracks.filter((candidate): candidate is ClipTrack => playing(candidate, files) > 0);
    if (candidates.length === 0) {
      throw invalid("lines", `no clip of timeline ${timeline.id} plays these takes: run \`voiceover.place\` first.`, { hint: "Place the lines, then caption them." });
    }
    const named = candidates.find((candidate) => candidate.name?.toLowerCase() === VOICE_TRACK_NAME.toLowerCase());
    voice = named ?? candidates.reduce((best, candidate) => (playing(candidate, files) > playing(best, files) ? candidate : best));
    subtitles = timeline.tracks.find((candidate): candidate is Extract<Track, { kind: "subtitles" }> => candidate.kind === "subtitles" && candidate.follows === voice!.id);
  }
  const { style } = resolveSubtitleStyle(subtitles?.style);
  const limits = { maxWords: style.maxWords, maxChars: style.maxChars };

  const { transcription } = deps;
  const scriptLanguage = read.script.voiceover.language;
  const language = scriptLanguage ?? transcription.language;
  deps.progress({ message: "Transcribing the takes", stage: "verify" });
  const heard = await verifyTakes({
    root: deps.root,
    takes: takes.map((take) => ({ id: take.line.id, spoken: take.line.spoken, display: take.line.display, file: join(deps.root, ...take.file.split("/")), pcm: take.pcm })),
    language,
    providerId: transcription.providerId,
    provider: transcription.provider,
    model: transcription.model,
    tools: transcription.tools,
    extractAudio: transcription.extractAudio,
    progress: deps.progress,
    signal: deps.signal,
  });
  warnings.push(...heard.warnings);
  const checked = heard.verification.status === "checked";
  const timing: CaptionsPlan["timing"] = checked
    ? { status: "heard", provider: transcription.providerId, model: heard.verification.model, reason: null }
    : { status: "proportional", provider: transcription.providerId, model: null, reason: (heard.verification.reason ?? "").replace(/^Verification skipped: /, "Not transcribed: ") };
  if (!checked) warnings.push(`${timing.reason} The words are spread over each take's phrases instead of timed by what was heard, unless the take's current transcript holds heard words.`);

  const numbers = numberLanguage(language);
  const transcripts: BuiltTranscript[] = [];
  const phrases: CaptionPhrase[] = [];
  const report: CaptionsPlan["lines"] = [];
  for (const take of takes) {
    const assetHash = await deps.hash(take.file);
    let words = heard.checks.get(take.line.id)?.words ?? null;
    let heardBy = { provider: transcription.providerId, model: heard.verification.model ?? transcription.model ?? "default" };
    if (words === null) {
      // Real timing already on file (an earlier `transcribe` or heard run of this take) beats a spread guess.
      const earlier = (await resolveTranscript(deps.root, take.file)).previous;
      if (earlier && earlier.assetHash === assetHash && earlier.provider !== SCRIPT_TIMING.provider && earlier.words.length > 0) {
        words = earlier.words.map((word) => ({ text: word.text, start: word.start, end: word.end }));
        heardBy = { provider: earlier.provider, model: earlier.model };
        warnings.push(`Line ${take.line.id}: not transcribed now, so timed by the words its current transcript holds (${earlier.provider}).`);
      }
    }
    const line = captionLine({ display: take.line.display, phrases: take.phrases, heard: words }, numbers, limits);
    if (line.timing === "unaligned") {
      warnings.push(
        `Line ${take.line.id}: fewer than half its written words were heard as written (heard ${JSON.stringify(words!.map((word) => word.text).join(" "))}), so its words are spread over its phrases. ` +
          "Respelled names count as not heard: if the take sounds right there is nothing to fix; if it misreads the line, generate it again with `voiceover generate`.",
      );
    }
    const source = line.timing === "heard" ? heardBy : SCRIPT_TIMING;
    const fresh: TranscriptWord[] = line.words.map((word) => ({ text: word.text, start: word.start, end: word.end }));
    let built: BuiltTranscript;
    try {
      built = await transcriptFromWords(deps.root, take.file, fresh, { assetHash, ...source, language });
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw invalid("lines", `line ${take.line.id}: ${(error as Error).message}`);
    }
    if (built.droppedEdits.length > 0) {
      warnings.push(`Line ${take.line.id}: the hand edits of words ${built.droppedEdits.join(", ")} of ${built.rel} were dropped: those words are not in the line's display form.`);
    }
    transcripts.push(built);
    const ids = built.transcript.words.map((word) => word.id);
    const chunks: string[] = [];
    for (const group of line.phrases) {
      const size = group.chunks.reduce((sum, count) => sum + count, 0);
      phrases.push({ asset: take.file, words: ids.slice(group.first, group.first + size), chunks: group.chunks });
      let at = group.first;
      for (const count of group.chunks) {
        chunks.push(line.words.slice(at, at + count).map((word) => word.text).join(" "));
        at += count;
      }
    }
    const placed = voice.clips.some((clip) => "asset" in clip && clip.asset === take.file);
    if (!placed) warnings.push(`Line ${take.line.id}: no clip of ${voice.id} plays its take, so its captions show once it is placed there (\`voiceover.place\`).`);
    report.push({ id: take.line.id, timing: line.timing, words: line.words.length, chunks, missing: line.missing, placed });
  }

  const kept = (subtitles?.phrases ?? []).filter((phrase) => !files.has(phrase.asset));
  const name = read.path.split("/").at(-1)!.replace(/\.md$/i, "");
  return {
    timeline: timeline.id,
    revision: timeline.revision,
    label: `Voiceover captions: ${name}${report.length === 1 ? "" : ` (${report.length} lines)`}`,
    script: read.path,
    track: { id: subtitles?.id ?? null, name: subtitles ? (subtitles.name ?? subtitles.id) : VOICE_CAPTIONS_TRACK_NAME, created: subtitles === undefined, follows: voice.id },
    phrases: [...kept, ...phrases],
    transcripts,
    timing,
    lines: report,
    warnings,
  };
}

/** One operation of the transaction. */
export type CaptionsStep =
  | { op: "track.add"; args: { kind: "subtitles"; name: string; follows: string } }
  | { op: "captions.set"; args: { track: string; phrases: CaptionPhrase[]; replace: true } };

/**
 * Write `plan`'s timeline part with `apply`: the subtitle track when it is missing, then every phrase it keeps in one
 * `captions.set` (`replace`, so the phrases it had on these takes go). The transcripts must be written before.
 */
export async function runCaptionsPlan(plan: CaptionsPlan, apply: (step: CaptionsStep) => Promise<StepResult>): Promise<{ revision: number; warnings: string[]; track: string }> {
  const warnings: string[] = [];
  let track = plan.track.id;
  if (track === null) {
    const done = await apply({ op: "track.add", args: { kind: "subtitles", name: plan.track.name ?? VOICE_CAPTIONS_TRACK_NAME, follows: plan.track.follows } });
    warnings.push(...done.warnings);
    track = done.added[0] ?? null;
    if (track === null) throw new Error("voiceover.captions: track.add reported no new track");
  }
  const done = await apply({ op: "captions.set", args: { track, phrases: plan.phrases, replace: true } });
  warnings.push(...done.warnings);
  return { revision: done.revision, warnings, track };
}
