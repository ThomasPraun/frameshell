// Generated sounds are project media that carry their own cache key: a RIFF chunk inside the WAV says which kind,
// variant and seed made it and where its anchor sits. No index file to lose, the key travels with a cloned project,
// and a file without the chunk (made or edited by hand) is the person's and never overwritten (ADR 0038, like ADR 0034).
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SFX_KINDS, type SfxKind } from "@frameshell/schema";
import { type PcmWav, wavBytes, wavChunk } from "../transcripts/window.js";
import { SR } from "./dsp.js";
import type { SfxRender, SfxSpec } from "./sfx.js";

/** Project-relative folder of every generated sound. */
export const SOUND_DIR = "assets/sound";

/**
 * Part of every take key. Bump when a recipe changes in a way that changes the samples: takes are made again under
 * new names, old ones stay as they are.
 */
export const SFX_KEY_VERSION = 1;

/** RIFF chunk id of the take mark. */
const MARK_CHUNK = "fssd";

/** The mark inside a take: its key, what made it and where its anchor is. */
export interface SoundMark {
  key: string;
  kind: SfxKind;
  variant: number;
  seed: number;
  /** The pitch multiplier used (jitter included). */
  pitch: number;
  /** Seeded level offset on top of the normalised peak, in dB. */
  levelDb: number;
  /** Seconds from the start of the take to the instant that lands on the cue (transient, whoosh peak, riser end). */
  peakAt: number;
}

/** Lowercase hex SHA-256 of everything that changes the samples; the caller's pitch and length only when set. */
export function sfxKey(spec: SfxSpec): string {
  const fields = [SFX_KEY_VERSION, spec.kind, spec.variant, spec.seed, spec.pitch ?? null, spec.length ?? null];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** Project-relative path of the take with key `key`: `assets/sound/<kind>-<first 8 hex of the key>.wav`. */
export function sfxFile(kind: SfxKind, key: string): string {
  return `${SOUND_DIR}/${kind}-${key.slice(0, 8)}.wav`;
}

/** The take as a WAV file (16-bit, mono or stereo) holding `mark`. */
export function sfxWavBytes(render: SfxRender, mark: SoundMark): Buffer {
  const audio: PcmWav = { sampleRate: render.sampleRate, bits: 16, channels: render.channels };
  return wavBytes(audio, [{ id: MARK_CHUNK, body: Buffer.from(JSON.stringify(mark), "utf8") }]);
}

/** The mark of a take's bytes; null when they hold none (not written by `sound.sfx`, or edited since). */
export function soundMarkOf(bytes: Buffer): SoundMark | null {
  const chunk = wavChunk(bytes, MARK_CHUNK);
  if (!chunk) return null;
  try {
    const mark = JSON.parse(chunk.toString("utf8")) as Partial<SoundMark>;
    const { key, kind, variant, seed, pitch, levelDb, peakAt } = mark;
    if (typeof key !== "string" || typeof kind !== "string" || !(SFX_KINDS as readonly string[]).includes(kind)) return null;
    if (![variant, seed, pitch, levelDb, peakAt].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
    return { key, kind: kind as SfxKind, variant: variant!, seed: seed!, pitch: pitch!, levelDb: levelDb!, peakAt: peakAt! };
  } catch {
    return null;
  }
}

/** `anchor` samples as the seconds a mark and a result carry (microsecond precision). */
export function anchorSeconds(anchor: number): number {
  return Math.round((anchor / SR) * 1e6) / 1e6;
}

/** The `.wav` in `dir` named `name`, in any letter case, with its bytes; null when there is none or the folder is missing. */
export async function readTake(dir: string, name: string): Promise<{ name: string; bytes: Buffer; mark: SoundMark | null } | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const found = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === name.toLowerCase());
  if (!found) return null;
  const bytes = await readFile(join(dir, found.name));
  return { name: found.name, bytes, mark: soundMarkOf(bytes) };
}
