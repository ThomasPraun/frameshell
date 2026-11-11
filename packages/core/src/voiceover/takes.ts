// Voiceover takes are project media that carry their own cache key: a RIFF chunk inside the WAV says which text,
// provider and voice made it. No index file to lose, the key travels with a cloned project, and a file without
// the chunk (made or edited by hand) is recognized as the person's and never overwritten (ADR 0034).
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SpeechOptions } from "@frameshell/plugin-api";
import { type Pcm16, pcmWavBytes, wavChunk } from "../transcripts/window.js";

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
