// Takes recorded in the app (ADR 0024 decisions 1 and 4): a take is a range of a session's sound files. At Cut its
// range is cut to 16 kHz mono PCM, transcribed and kept as words on the session clock; when the session ends, the
// takes' words become the ordinary transcripts of the session's sound files.
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptWord, TranscriptionProvider, TranscribeContext } from "@frameshell/plugin-api";
import { SCHEMA_VERSION, TRANSCRIPT_SCHEMA_URL, type ShootScript, type ShootTake, type TakeSession, type Transcript, parseTranscript } from "@frameshell/schema";
import { exists, writeJsonAtomic } from "../fs-util.js";
import { TRANSCRIPTION_SAMPLE_RATE } from "../transcripts/audio.js";
import { assignWordIds } from "../transcripts/ids.js";
import { readPrevious, resolveTranscript } from "../transcripts/transcriber.js";
import { readPcmWav } from "../transcripts/window.js";
import type { HeardWord } from "./compare.js";

/** Project-relative folder of each recorded take's PCM and words, kept while its session's files are being written. */
export const TAKE_WORDS_DIR = ".frameshell/shoot/takes";
/** Suffix of a session's sound file while it records (the recorder's, `apps/desktop/src/main/shoot-session.ts`). */
const PART_SUFFIX = ".part";

/** Words of one sound file of a take, on the session clock. */
export interface TakeSoundWords {
  asset: string;
  offset: number;
  words: HeardWord[];
  provider: string;
  model: string;
  language: string | null;
}

/** Contents of `<TAKE_WORDS_DIR>/<take>.json`. */
export interface TakeWords {
  version: 1;
  take: string;
  session: string;
  start: number;
  end: number;
  sounds: TakeSoundWords[];
}

/** A take recorded in the app, with its session range. */
export type SessionTake = ShootTake & { session: TakeSession };

/** True for a take that is a range of a session. */
export function isSessionTake(take: ShootTake): take is SessionTake {
  return take.session !== undefined;
}

/** Absolute path of a take's words file. */
export function takeWordsPath(root: string, take: string): string {
  return join(root, ...TAKE_WORDS_DIR.split("/"), `${take}.json`);
}

/** A take's words and the file's text (for cache keys); null when it was not transcribed (yet). */
export async function readTakeWords(root: string, take: string): Promise<{ text: string; value: TakeWords } | null> {
  let text: string;
  try {
    text = await readFile(takeWordsPath(root, take), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as TakeWords;
    return value.version === 1 && value.take === take && Array.isArray(value.sounds) ? { text, value } : null;
  } catch {
    return null;
  }
}

/** Heard words of a take, every sound file merged, in time order. */
export function takeHeard(words: TakeWords): HeardWord[] {
  return words.sounds.flatMap((sound) => sound.words).sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Seconds of the sound file `offset` places on the session clock, for the range `start`..`end`. */
export function fileRange(start: number, end: number, offset: number): { from: number; to: number } {
  return { from: Math.max(0, start - offset), to: Math.max(0, end - offset) };
}

/** Writes 16 kHz mono 16-bit PCM WAV of `from`..`to` seconds of `input`'s first audio stream. */
export type RangeExtractor = (input: string, from: number, to: number, output: string) => Promise<void>;

/** {@link RangeExtractor} with ffmpeg; reads a file still being written up to its last whole chunk. */
export function ffmpegRangeExtractor(ffmpeg: () => Promise<string>, signal?: AbortSignal): RangeExtractor {
  return async (input, from, to, output) => {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(from), "-t", String(Math.max(0.05, to - from))];
    args.push("-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(TRANSCRIPTION_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", output);
    const file = await ffmpeg();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...(signal ? { signal } : {}) });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg could not cut ${input} (exit ${code}): ${stderr.trim()}`))));
    });
  };
}

/** Input of {@link transcribeTake}. */
export interface TranscribeTakeOptions {
  root: string;
  take: SessionTake;
  extract: RangeExtractor;
  providerId: string;
  provider: TranscriptionProvider;
  model?: string | undefined;
  language?: string | undefined;
  context: TranscribeContext;
}

/**
 * Cut the take's range of each sound file (the growing `.part` while the session records) to a WAV under
 * {@link TAKE_WORDS_DIR}, transcribe it, and write the words on the session clock. A sound file with no audio
 * in the range yet gives no words.
 */
export async function transcribeTake(options: TranscribeTakeOptions): Promise<TakeWords> {
  const { root, take } = options;
  const { session } = take;
  const sounds: TakeSoundWords[] = [];
  for (const [index, sound] of session.sounds.entries()) {
    const final = join(root, ...sound.asset.split("/"));
    const input = (await exists(final)) ? final : final + PART_SUFFIX;
    const { from, to } = fileRange(session.start, session.end, sound.offset);
    const wav = join(root, ...TAKE_WORDS_DIR.split("/"), `${take.id}-${index + 1}.wav`);
    await mkdir(join(root, ...TAKE_WORDS_DIR.split("/")), { recursive: true });
    await options.extract(input, from, to, wav);
    const asked = { ...(options.model ? { model: options.model } : {}), ...(options.language ? { language: options.language } : {}) };
    const result = await options.provider.transcribe(wav, asked, options.context);
    const at = from + sound.offset;
    sounds.push({
      asset: sound.asset,
      offset: sound.offset,
      words: result.words.map((word: TranscriptWord) => ({ text: word.text, start: round(at + word.start), end: round(at + word.end), speaker: null })),
      provider: options.providerId,
      model: result.model,
      language: result.language ?? null,
    });
  }
  const words: TakeWords = { version: 1, take: take.id, session: session.id, start: session.start, end: session.end, sounds };
  await writeJsonAtomic(takeWordsPath(root, take.id), words);
  return words;
}

/**
 * A stand-in transcriber for end-to-end tests (`FRAMESHELL_SHOOT_STAND_IN=1`): it "hears" `words` spread evenly
 * over the middle of the WAV, so a test controls what a take says without a speech model.
 */
export function standInProvider(words: readonly string[]): TranscriptionProvider {
  return {
    id: "stand-in",
    async transcribe(audio) {
      const pcm = await readPcmWav(audio);
      const seconds = pcm ? pcm.samples.length / pcm.sampleRate : 0;
      const from = seconds * 0.1;
      const step = words.length > 0 ? (seconds * 0.8) / words.length : 0;
      return {
        model: "stand-in",
        words: words.map((text, i) => ({ text, start: round(from + i * step), end: round(from + (i + 0.8) * step) })),
      };
    },
  };
}

/**
 * What the stand-in hears for a take starting at `scene`: every spoken word of the scene except the middle word of
 * its longest line (when that line has 5 words or more), so such a take has one `missing` deviation to accept or
 * record again.
 */
export function standInWords(script: ShootScript, scene: string): string[] {
  const lines = script.scenes.find((candidate) => candidate.slug === scene)?.lines.filter((line) => line.words.length > 0) ?? [];
  const longest = lines.reduce<(typeof lines)[number] | null>((best, line) => (best === null || line.words.length > best.words.length ? line : best), null);
  return lines.flatMap((line) =>
    line === longest && line.words.length >= 5 ? line.words.filter((_, i) => i !== Math.floor(line.words.length / 2)) : line.words,
  );
}

/** What {@link writeSessionTranscripts} needs from the daemon. */
export interface SessionTranscriptDeps {
  /** `sha256:<hex>` of a project file. */
  hash(rel: string): Promise<string>;
}

/**
 * The takes' words of each of the session's sound files as that file's transcript (SPEC §5.4): words on the file's
 * own clock, takes in time order, word ids kept from a transcript already there. Sound files with no take words
 * are left alone. Returns the transcript files written.
 */
export async function writeSessionTranscripts(root: string, takes: readonly SessionTake[], deps: SessionTranscriptDeps): Promise<string[]> {
  const perAsset = new Map<string, { words: TranscriptWord[]; provider: string; model: string; language: string | null }>();
  for (const take of [...takes].sort((a, b) => a.session.start - b.session.start)) {
    const read = await readTakeWords(root, take.id);
    if (!read) continue;
    for (const sound of read.value.sounds) {
      const entry = perAsset.get(sound.asset) ?? { words: [], provider: sound.provider, model: sound.model, language: sound.language };
      for (const word of sound.words) entry.words.push({ text: word.text, start: round(Math.max(0, word.start - sound.offset)), end: round(Math.max(0, word.end - sound.offset)) });
      perAsset.set(sound.asset, entry);
    }
  }
  const written: string[] = [];
  for (const [asset, entry] of perAsset) {
    if (!(await exists(join(root, ...asset.split("/"))))) continue;
    const { rel, path } = await resolveTranscript(root, asset);
    const previous = await readPrevious(path);
    const words = entry.words.sort((a, b) => a.start - b.start).map((word) => ({ ...word, end: Math.max(word.start, word.end) }));
    const assigned = assignWordIds(words, previous);
    const transcript: Transcript = {
      $schema: TRANSCRIPT_SCHEMA_URL,
      schemaVersion: SCHEMA_VERSION,
      asset,
      assetHash: await deps.hash(asset),
      provider: entry.provider,
      model: entry.model,
      ...(entry.language ? { language: entry.language } : {}),
      words: assigned.words,
      edits: assigned.edits,
      nextWordId: assigned.nextWordId,
    };
    const checked = parseTranscript(transcript);
    if (!checked.ok) throw new Error(`the words of ${asset} do not make a valid transcript:\n${checked.error}`);
    await writeJsonAtomic(path, transcript);
    written.push(rel);
  }
  return written;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
