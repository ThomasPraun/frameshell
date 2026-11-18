// Voiceover takes are project media that carry their own cache key: a RIFF chunk inside the WAV says which text,
// provider and voice made it. No index file to lose, the key travels with a cloned project, and a file without
// the chunk (made or edited by hand) is recognized as the person's and never overwritten (ADR 0034).
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SpeechOptions } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type VoiceoverLine, shootSlug } from "@frameshell/schema";
import { type Pcm16, pcmOfWav, pcmWavBytes, wavChunk } from "../transcripts/window.js";
import { type Phrase, splitPhrases } from "./split.js";

/** Project-relative folder of every voiceover script's takes: `assets/voiceover/<script slug>/<line id>.wav`. */
export const VOICEOVER_DIR = "assets/voiceover";

/**
 * Part of every take key. Bump when what a key stands for changes (trimming, the spoken-text rules): every take
 * is generated again, so it costs money with a paid provider.
 */
export const TAKE_KEY_VERSION = 1;

/** RIFF chunk id of the take mark. */
const MARK_CHUNK = "fsvo";

/** What a take was made from; its {@link takeKey} is the cache key. */
export interface TakeInput {
  provider: string;
  /** The provider's `version`, `"1"` when absent. */
  providerVersion: string;
  voice: string;
  options: SpeechOptions;
  /** Spoken form of the line. */
  text: string;
}

/** The mark inside a take: its key plus what made it, for people reading the file. */
export interface TakeMark {
  key: string;
  provider: string;
  voice: string;
  text: string;
}

/** Lowercase hex SHA-256 of everything that changes how a line sounds. */
export function takeKey(input: TakeInput): string {
  const options = Object.entries(input.options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fields = [TAKE_KEY_VERSION, input.provider, input.providerVersion, input.voice, options, input.text];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** `pcm` as a WAV file holding `mark`. */
export function takeWavBytes(pcm: Pcm16, mark: TakeMark): Buffer {
  return pcmWavBytes(pcm, [{ id: MARK_CHUNK, body: Buffer.from(JSON.stringify(mark), "utf8") }]);
}

/** The mark of a take's bytes; null when they hold none (not written by `voiceover.generate`, or edited since). */
export function takeMarkOf(bytes: Buffer): TakeMark | null {
  const chunk = wavChunk(bytes, MARK_CHUNK);
  if (!chunk) return null;
  try {
    const mark = JSON.parse(chunk.toString("utf8")) as Partial<TakeMark>;
    if (typeof mark.key !== "string" || typeof mark.provider !== "string" || typeof mark.voice !== "string" || typeof mark.text !== "string") return null;
    return { key: mark.key, provider: mark.provider, voice: mark.voice, text: mark.text };
  } catch {
    return null;
  }
}

/** One `.wav` of a takes folder: its bytes and their mark (null = not a take this pipeline wrote). */
export interface TakeFile {
  name: string;
  bytes: Buffer;
  mark: TakeMark | null;
}

/** Every `.wav` directly in `dir` by file name; empty when the folder does not exist. */
export async function readTakes(dir: string): Promise<Map<string, TakeFile>> {
  const names = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const takes = new Map<string, TakeFile>();
  for (const entry of names) {
    if (!entry.isFile() || !/\.wav$/i.test(entry.name)) continue;
    const bytes = await readFile(join(dir, entry.name));
    takes.set(entry.name, { name: entry.name, bytes, mark: takeMarkOf(bytes) });
  }
  return takes;
}

/** The take of one script line, read for placing or captioning it. */
export interface LineTake {
  line: VoiceoverLine;
  /** Project-relative take: `assets/voiceover/<script slug>/<line id>.wav`. */
  file: string;
  pcm: Pcm16;
  /** Seconds. */
  duration: number;
  /** The take cut at its silences ({@link splitPhrases}), derived on every read. */
  phrases: Phrase[];
}

/**
 * The takes `voiceover.generate` wrote for `lines` of the script at project-relative `script`, with their phrases, for
 * `op` (`voiceover.place`, `voiceover.captions`). Warns about a take said from older text than its line has now.
 * Throws `InvalidOperation` naming the lines that have no take, or a take that is not a mono 16-bit PCM WAV.
 */
export async function readLineTakes(root: string, script: string, lines: readonly VoiceoverLine[], op: string): Promise<{ takes: LineTake[]; warnings: string[] }> {
  const dir = `${VOICEOVER_DIR}/${shootSlug(script)}`;
  const takes = await readTakes(join(root, ...dir.split("/")));
  const byName = new Map([...takes.values()].map((take) => [take.name.toLowerCase(), take] as const));
  const invalid = (message: string, extra: Record<string, unknown>) =>
    new RpcError(ErrorCode.InvalidOperation, `${op}: lines: ${message}`, { op, reason: message, field: "lines", ...extra });
  const missing = lines.filter((line) => !byName.has(`${line.id}.wav`)).map((line) => line.id);
  if (missing.length > 0) {
    throw invalid(`no take for ${missing.join(", ")} in ${dir}/: run \`voiceover.generate\` first.`, { missing, dir, hint: "Generate the lines first." });
  }
  const warnings: string[] = [];
  const read = lines.map((line) => {
    const take = byName.get(`${line.id}.wav`)!;
    const file = `${dir}/${take.name}`;
    const pcm = pcmOfWav(take.bytes);
    if (!pcm) throw invalid(`${file} is not a mono 16-bit PCM WAV.`, { file });
    if (take.mark && take.mark.text !== line.spoken) {
      warnings.push(`Line ${line.id}: its take was said from older text (${JSON.stringify(take.mark.text)}); run \`voiceover.generate\` to say the line as it is now.`);
    }
    return { line, file, pcm, duration: pcm.samples.length / pcm.sampleRate, phrases: splitPhrases(pcm) };
  });
  return { takes: read, warnings };
}
