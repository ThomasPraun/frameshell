import { randomBytes } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranscriptWord, TranscriptionProvider, TranscriptionResult } from "@frameshell/plugin-api";
import {
  ErrorCode,
  type LostWord,
  type Progress,
  RpcError,
  type TranscribeVerifyResult,
  type UncertainWord,
} from "@frameshell/protocol";
import type { MediaClip, Timeline, Transcript } from "@frameshell/schema";
import { type WordHearing, alignWords, comparableText } from "./align.js";
import { type AudioExtractor, extractAudioWithFfmpeg } from "./audio.js";
import { type TranscriberTools, resolveTranscript } from "./transcriber.js";
import { readPcmWav, transcribeWindow } from "./window.js";

/** Input of {@link verifyExport}. */
export interface VerifyExportOptions {
  /** Project root (real path). */
  projectDir: string;
  /** Exported file, absolute. May live outside the project. */
  exportFile: string;
  /** Id reported back; `timeline` is its parsed content. */
  timelineId: string;
  /** The timeline the export was rendered from. */
  timeline: Timeline;
  /** Provider id reported back and matched against the transcripts' `provider`. */
  providerId: string;
  /** The provider, or a loader run after the cheap checks. */
  provider: TranscriptionProvider | (() => Promise<TranscriptionProvider>);
  /** Absent: the source transcripts' model when they come from the same provider, else the provider default. */
  model?: string | undefined;
  /** Absent: the source transcripts' language. */
  language?: string | undefined;
  /** Binaries and models for extraction and the provider. */
  tools: TranscriberTools;
  /** Defaults to ffmpeg via `tools`. */
  extractAudio?: AudioExtractor | undefined;
  /**
   * Current `sha256:<hex>` of a project-relative asset, or null when unknown.
   * A transcript whose `assetHash` differs is stale and its clips go unchecked.
   * Absent: transcripts are trusted.
   */
  assetHash?: ((assetRel: string) => Promise<string | null>) | undefined;
  progress?: ((progress: Progress) => void) | undefined;
}

/** Source seconds from a cut within which a missing word is a lost candidate at that cut. */
const CUT_ZONE_S = 0.5;
/** Export and timeline lengths may differ this much (frame rounding, encoder padding) before it is suspicious. */
const DURATION_TOLERANCE_S = 0.5;
/** Confidence factor of a missing word that repeats its neighbouring phrase (whisper collapse, ADR 0003). */
const REPEAT_FACTOR = 0.3;
/** Confidence factor of a garbled word at a cut, or a missing word away from cuts. */
const WEAK_FACTOR = 0.5;
/**
 * Seconds of export audio kept on each side of a lost candidate when it is
 * re-transcribed alone: enough context for whisper to decode the phrase
 * (#115: a 12 s window heard what the full pass skipped).
 */
const RECHECK_PAD_S = 5;

/** One source word the timeline keeps, placed on the timeline. */
interface KeptWord extends Omit<LostWord, "confidence"> {
  /** Source word confidence; 1 when the provider gave none. */
  sourceConfidence: number;
}

/** Transcript lookup outcome of one asset. */
type SourceTranscript = { rel: string; transcript: Transcript } | { unchecked: "no-transcript" | "stale-transcript" };

/**
 * `transcribe --verify` (SPEC §3.5 step 6): re-transcribe an export and
 * report the source words the timeline keeps that the export lost at a cut.
 *
 * Kept words: each unmuted media clip's transcript words whose midpoint lies
 * inside the clip's visible `[in, out)`, mapped to timeline seconds. The
 * export's audio runs on the timeline clock, so both sides align on time as
 * well as text ({@link alignWords}). A clip edge is a cut when source speech
 * was removed across it. A word missing within 0.5 source seconds of a cut,
 * or crossing it, is re-transcribed in its own audio window
 * ({@link settleCandidates}); still missing, it is `lost` only when the cut
 * falls inside it (`clipped`). Everything else unconfirmed is `uncertain`,
 * so whisper's own misses (a collapsed repeat, a word away from any cut, a
 * word whole inside its clip) never show up as losses.
 *
 * Writes nothing but temporary WAVs under `.frameshell/cache/verify/`.
 * Throws `AssetNotFound` (no export), `InvalidProjectFile` (broken
 * transcript), `TranscriptionFailed`, or the binary manager's errors.
 */
export async function verifyExport(options: VerifyExportOptions): Promise<TranscribeVerifyResult> {
  const started = performance.now();
  const { projectDir, exportFile, timeline, providerId, tools } = options;
  const progress = options.progress ?? (() => {});
  const extractAudio = options.extractAudio ?? extractAudioWithFfmpeg;
  if (!(await isFile(exportFile))) {
    throw new RpcError(
      ErrorCode.AssetNotFound,
      `Export ${exportFile} does not exist. Render one first: \`frameshell render --out ${exportFile}\`.`,
      { path: exportFile },
    );
  }
  const sources = await sourceTranscripts(projectDir, timeline, options.assetHash);
  const { words: kept, unchecked, warnings } = keptWords(timeline, sources);
  const transcripts = [...sources.values()].flatMap((source) => ("transcript" in source ? [source.transcript] : []));
  const model = options.model ?? transcripts.find((t) => t.provider === providerId)?.model;
  const language = options.language ?? transcripts.find((t) => t.language)?.language;
  const provider = typeof options.provider === "function" ? await options.provider() : options.provider;

  const failed = (error: unknown): never => {
    if (error instanceof RpcError) throw error;
    const details = (error as Error)?.message ?? String(error);
    throw new RpcError(ErrorCode.TranscriptionFailed, `Transcribing export ${exportFile} with ${providerId} failed: ${details}`, {
      provider: providerId,
      asset: exportFile,
      details,
    });
  };
  const audio = join(projectDir, ".frameshell", "cache", "verify", `${randomBytes(6).toString("hex")}.wav`);
  const transcribeOptions = { ...(model ? { model } : {}), ...(language ? { language } : {}) };
  const context = {
    ensureBinary: (name: string) => tools.ensureBinary(name, progress),
    ensureModel: (id: string) => tools.ensureModel(id, progress),
    progress: (update: Progress) => progress({ ...update }),
  };
  let result: TranscriptionResult;
  let exportSeconds: number | null;
  let report: Report;
  let heardCount: number;
  try {
    progress({ message: `Extracting audio from ${exportFile}` });
    try {
      await mkdir(dirname(audio), { recursive: true });
      await extractAudio({ path: exportFile }, audio, () => tools.ensureBinary("ffmpeg", progress));
    } catch (error) {
      failed(error);
    }
    exportSeconds = await wavSeconds(audio);
    try {
      result = await provider.transcribe(audio, transcribeOptions, context);
    } catch (error) {
      return failed(error);
    }

    progress({ message: "Comparing with the source transcripts" });
    const hearing = alignWords(
      kept.map((word) => ({ text: word.text, start: word.at, end: word.end })),
      result.words,
    );
    heardCount = hearing.filter((word) => word.status === "heard").length;
    report = classify(kept, hearing, result.words);
    if (report.candidates.length > 0) {
      progress({ message: `Re-checking ${report.candidates.length} word(s) at cuts in their own audio window` });
      const pcm = await readPcmWav(audio);
      const transcribe = (path: string) => provider.transcribe(path, transcribeOptions, context);
      const recheck = async (from: number, to: number) => {
        if (!pcm) return null;
        try {
          return await transcribeWindow({ pcm, from, to, dir: dirname(audio), transcribe });
        } catch (error) {
          return failed(error);
        }
      };
      heardCount += (await settleCandidates(kept, report, recheck)).heard;
    }
  } finally {
    await rm(audio, { force: true });
  }

  const timelineSeconds = timelineDuration(timeline);
  if (exportSeconds !== null && Math.abs(exportSeconds - timelineSeconds) > DURATION_TOLERANCE_S) {
    warnings.push(
      `The export is ${round(exportSeconds)} s but the timeline is ${timelineSeconds} s: it may predate the last edit, so ` +
        "words may be reported lost that are not. Re-export with `frameshell render` and verify again.",
    );
  }
  if (kept.length === 0 && unchecked.length > 0) {
    warnings.push("No clip could be checked. Transcribe their assets first: `frameshell transcribe <asset>`.");
  }
  return {
    export: exportFile,
    timeline: options.timelineId,
    revision: timeline.revision,
    provider: providerId,
    model: result.model,
    language: result.language ?? language ?? null,
    duration: { export: exportSeconds === null ? null : round(exportSeconds), timeline: timelineSeconds },
    expected: kept.length,
    heard: heardCount,
    lost: report.lost,
    uncertain: report.uncertain,
    confidence: report.confidence,
    unchecked,
    warnings,
    seconds: Math.round(performance.now() - started) / 1000,
  };
}

/** Transcript of every asset an unmuted media clip plays, or why it cannot be checked. */
async function sourceTranscripts(
  projectDir: string,
  timeline: Timeline,
  assetHash: VerifyExportOptions["assetHash"],
): Promise<Map<string, SourceTranscript>> {
  const sources = new Map<string, SourceTranscript>();
  for (const clip of mediaClips(timeline)) {
    if (sources.has(clip.asset)) continue;
    let found: { rel: string; previous: Transcript | null };
    try {
      found = await resolveTranscript(projectDir, clip.asset);
    } catch (error) {
      // Both names belong to other assets: this one has none.
      if (error instanceof RpcError && error.code === ErrorCode.TranscriptNameTaken) found = { rel: "", previous: null };
      else throw error;
    }
    if (!found.previous) {
      sources.set(clip.asset, { unchecked: "no-transcript" });
      continue;
    }
    const current = assetHash ? await assetHash(clip.asset).catch(() => null) : null;
    if (current !== null && current !== found.previous.assetHash) sources.set(clip.asset, { unchecked: "stale-transcript" });
    else sources.set(clip.asset, { rel: found.rel, transcript: found.previous });
  }
  return sources;
}

function mediaClips(timeline: Timeline): MediaClip[] {
  return timeline.tracks.flatMap((track) =>
    track.kind === "subtitles" ? [] : track.clips.filter((clip): clip is MediaClip => clip.type === "media" && clip.audio?.muted !== true),
  );
}

/** A media clip as it plays: overlaps trimmed the way the export compiler trims them (the later clip wins). */
interface Visible {
  clip: MediaClip;
  speed: number;
  /** Timeline seconds [start, end). */
  end: number;
  /** Source seconds [in, out) actually played. */
  out: number;
}

/** The source words each clip keeps, by timeline position; unchecked clips; skipped clip types. */
function keptWords(
  timeline: Timeline,
  sources: ReadonlyMap<string, SourceTranscript>,
): { words: KeptWord[]; unchecked: TranscribeVerifyResult["unchecked"]; warnings: string[] } {
  const words: KeptWord[] = [];
  const unchecked: TranscribeVerifyResult["unchecked"] = [];
  const warnings: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) {
      if (clip.type !== "media") warnings.push(`Clip ${clip.id} on track ${track.id} is a \`${clip.type}\` clip; its words are not checked.`);
    }
    const visible = visibleClips(track.clips.filter((clip): clip is MediaClip => clip.type === "media"));
    visible.forEach((placed, index) => {
      const { clip, speed } = placed;
      if (clip.audio?.muted === true) return;
      const source = sources.get(clip.asset);
      if (!source) return;
      if ("unchecked" in source) {
        unchecked.push({ clip: clip.id, track: track.id, asset: clip.asset, reason: source.unchecked });
        return;
      }
      const { transcript, rel } = source;
      const all = transcript.words;
      // An edge is a cut when speech was removed across it, and the neighbour does not simply continue the source.
      const continues = (a: Visible | undefined, b: Visible | undefined) =>
        a !== undefined &&
        b !== undefined &&
        a.clip.asset === b.clip.asset &&
        a.speed === b.speed &&
        Math.abs(a.out - b.clip.in) < 0.01 &&
        Math.abs(a.end - b.clip.start) < 0.01;
      const inIsCut = !continues(visible[index - 1], placed) && all.some((word) => word.start < clip.in);
      const outIsCut = !continues(placed, visible[index + 1]) && all.some((word) => word.end > placed.out);
      const toTimeline = (source: number) => round(clip.start + (source - clip.in) / speed);
      for (const word of all) {
        const mid = (word.start + word.end) / 2;
        if (mid < clip.in || mid >= placed.out) continue;
        const fromIn = inIsCut ? Math.max(0, word.start - clip.in) : Infinity;
        const fromOut = outIsCut ? Math.max(0, placed.out - word.end) : Infinity;
        const cut =
          Math.min(fromIn, fromOut) > CUT_ZONE_S
            ? null
            : fromIn <= fromOut
              ? { edge: "in" as const, at: round(clip.start) }
              : { edge: "out" as const, at: round(placed.end) };
        words.push({
          word: word.id,
          text: transcript.edits[word.id]?.text ?? word.text,
          transcript: rel,
          asset: clip.asset,
          track: track.id,
          clip: clip.id,
          at: toTimeline(Math.max(word.start, clip.in)),
          end: toTimeline(Math.min(word.end, placed.out)),
          source: { start: word.start, end: word.end },
          cut,
          clipped: word.start < clip.in || word.end > placed.out,
          sourceConfidence: word.confidence ?? 1,
        });
      }
    });
  }
  words.sort((a, b) => a.at - b.at);
  return { words, unchecked, warnings };
}

function visibleClips(clips: readonly MediaClip[]): Visible[] {
  const placed = clips
    .map((clip) => {
      const speed = clip.speed ?? 1;
      return { clip, speed, end: clip.start + (clip.out - clip.in) / speed, out: clip.out };
    })
    .sort((a, b) => a.clip.start - b.clip.start);
  for (let i = 1; i < placed.length; i++) {
    const before = placed[i - 1]!;
    const next = placed[i]!.clip.start;
    if (before.end > next) {
      before.end = Math.max(before.clip.start, next);
      before.out = before.clip.in + (before.end - before.clip.start) * before.speed;
    }
  }
  return placed.filter((p) => p.end > p.clip.start);
}

/** Outcome of {@link classify}: settled words, plus missing words at a cut still to re-check. */
interface Report {
  lost: LostWord[];
  uncertain: UncertainWord[];
  confidence: number;
  /** Indexes into the kept words, in time order. */
  candidates: number[];
  /** The run's agreement, a factor of every reported word's confidence. */
  agreement: number;
}

/**
 * Split unconfirmed kept words into uncertain ones and lost candidates
 * (missing at a cut, not a repeat): those need {@link settleCandidates}
 * before any is reported lost.
 */
function classify(kept: readonly KeptWord[], hearing: readonly WordHearing[], heard: readonly { text: string }[]): Report {
  // Agreement away from cuts measures how well this run reproduces the sources at all.
  const interior = kept.map((word, i) => ({ word, hearing: hearing[i]! })).filter(({ word }) => word.cut === null);
  const agreement = interior.length === 0 ? 1 : interior.filter(({ hearing }) => hearing.status !== "missing").length / interior.length;
  const repeats = repeatCollapses(kept, hearing);
  const uncertain: UncertainWord[] = [];
  const candidates: number[] = [];
  kept.forEach((word, i) => {
    const how = hearing[i]!;
    const placed = reported(word, agreement);
    if (how.status === "heard") return;
    if (how.status === "different") {
      if (word.cut === null) return; // Audio is there; the text is a transcription variant.
      const heardAs = how.heard.map((k) => heard[k]!.text.trim()).join(" ");
      uncertain.push({ ...placed(WEAK_FACTOR), reason: "garbled", heardAs });
    } else if (repeats.has(i)) {
      uncertain.push({ ...placed(REPEAT_FACTOR), reason: "repeat", heardAs: null });
    } else if (word.cut === null) {
      uncertain.push({ ...placed(WEAK_FACTOR), reason: "unheard", heardAs: null });
    } else {
      candidates.push(i);
    }
  });
  return { lost: [], uncertain, confidence: round2(agreement), candidates, agreement };
}

/** `word` as a report entry with confidence `source confidence × factor × agreement`. */
function reported(word: KeptWord, agreement: number): (factor: number) => LostWord {
  const { sourceConfidence, ...placed } = word;
  return (factor) => ({ ...placed, confidence: round2(sourceConfidence * factor * agreement) });
}

/**
 * Settle the lost candidates of `report` in place (#115): whisper can skip a
 * phrase in a long pass that it hears fine in a short one, so each candidate
 * is re-transcribed in a window of {@link RECHECK_PAD_S} around it first.
 * Heard there: confirmed, not reported. Heard as other text: `garbled`.
 * Still missing: `lost` only when the cut falls inside the word (`clipped`);
 * a word whole inside its clip is a recognition miss (`unheard`), which no
 * trim can fix. `recheck` returns the window's words on the export clock, or
 * null when the audio cannot be re-checked (then no candidate is confirmed).
 * Returns how many candidates were heard.
 */
async function settleCandidates(
  kept: readonly KeptWord[],
  report: Report,
  recheck: (from: number, to: number) => Promise<TranscriptWord[] | null>,
): Promise<{ heard: number }> {
  const windows: { from: number; to: number; members: number[] }[] = [];
  for (const i of report.candidates) {
    const word = kept[i]!;
    const from = Math.max(0, word.at - RECHECK_PAD_S);
    const to = word.end + RECHECK_PAD_S;
    const last = windows.at(-1);
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.members.push(i);
    } else windows.push({ from, to, members: [i] });
  }
  let heardCount = 0;
  for (const window of windows) {
    const words = await recheck(window.from, window.to);
    const inside = kept.flatMap((word, i) => (word.end > window.from && word.at < window.to ? [i] : []));
    const hearing = words
      ? alignWords(
          inside.map((i) => ({ text: kept[i]!.text, start: kept[i]!.at, end: kept[i]!.end })),
          words,
        )
      : [];
    for (const i of window.members) {
      const word = kept[i]!;
      const placed = reported(word, report.agreement);
      const how: WordHearing = words ? hearing[inside.indexOf(i)]! : { status: "missing" };
      if (how.status === "heard") heardCount++;
      else if (how.status === "different") {
        const heardAs = how.heard.map((k) => words![k]!.text.trim()).join(" ");
        report.uncertain.push({ ...placed(WEAK_FACTOR), reason: "garbled", heardAs });
      } else if (word.clipped) report.lost.push(placed(1));
      else report.uncertain.push({ ...placed(WEAK_FACTOR), reason: "unheard", heardAs: null });
    }
  }
  report.uncertain.sort((a, b) => a.at - b.at);
  return { heard: heardCount };
}

/**
 * Indexes of missing words forming a run whose text equals the heard run
 * right before or after it: the shape of whisper collapsing a repeated
 * phrase (ADR 0003), which a cut cannot be told apart from by text alone.
 */
function repeatCollapses(kept: readonly KeptWord[], hearing: readonly WordHearing[]): Set<number> {
  const found = new Set<number>();
  const text = (from: number, to: number) => kept.slice(from, to).map((word) => comparableText(word.text)).join(" ");
  const allHeard = (from: number, to: number) => hearing.slice(from, to).every((how) => how.status === "heard");
  let i = 0;
  while (i < kept.length) {
    if (hearing[i]!.status !== "missing") {
      i++;
      continue;
    }
    let j = i;
    while (j < kept.length && hearing[j]!.status === "missing") j++;
    const length = j - i;
    const run = text(i, j);
    const before = i - length >= 0 && allHeard(i - length, i) && text(i - length, i) === run;
    const after = j + length <= kept.length && allHeard(j, j + length) && text(j, j + length) === run;
    if (run.length > 0 && (before || after)) for (let k = i; k < j; k++) found.add(k);
    i = j;
  }
  return found;
}

/** Timeline seconds up to the end of its last clip; nested timelines without `duration` are not counted. */
function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) {
      if ("asset" in clip) end = Math.max(end, clip.start + (clip.out - clip.in) / (clip.speed ?? 1));
      else if (clip.duration !== undefined) end = Math.max(end, clip.start + clip.duration);
    }
  }
  return round(end);
}

/** Length of a PCM WAV from its header, or null when it cannot be read. */
async function wavSeconds(path: string): Promise<number | null> {
  let file;
  try {
    file = await open(path, "r");
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const size = (await file.stat()).size;
    if (bytesRead < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return null;
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= bytesRead; ) {
      const id = header.toString("ascii", offset, offset + 4);
      const length = header.readUInt32LE(offset + 4);
      if (id === "fmt ") byteRate = header.readUInt32LE(offset + 16);
      // ffmpeg writing to a pipe leaves the data size unset: the rest of the file is data.
      if (id === "data") return byteRate > 0 ? Math.min(length, size - offset - 8) / byteRate : null;
      offset += 8 + length + (length % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
