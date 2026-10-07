import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptWord } from "@frameshell/plugin-api";
import type { GcClass } from "../gc.js";

/** Project-relative folder of the window WAVs `transcribe` cuts to re-check long words; each lives only while its request runs. */
export const TRANSCRIBE_WINDOW_DIR = ".frameshell/cache/transcribe";

/** Name of a WAV {@link transcribeWindow} writes. */
const WINDOW_WAV = /^window-[0-9a-f]{12}\.wav$/;

/**
 * What an entry of a folder holding {@link transcribeWindow} WAVs is, for
 * `gc`: a window WAV is the leftover of an interrupted run (a temp); other
 * names are not ours and are kept.
 */
export function classifyWindowWav(name: string, isDirectory: boolean): GcClass {
  return !isDirectory && WINDOW_WAV.test(name) ? { kind: "temp", key: null } : null;
}

/** Mono 16-bit PCM samples of a transcription WAV. */
export interface Pcm16 {
  /** Samples per second. */
  sampleRate: number;
  /** Mono 16-bit samples, in time order. */
  samples: Int16Array;
}

/**
 * Samples of a mono 16-bit PCM WAV (the transcription provider contract), or
 * null when the file is anything else. Walks chunks (ffmpeg writes LIST before
 * data); a data size past the file end (ffmpeg writing to a pipe) means "rest
 * of the file".
 */
export async function readPcmWav(path: string): Promise<Pcm16 | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let sampleRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) return null;
      const format = bytes.readUInt16LE(body);
      const channels = bytes.readUInt16LE(body + 2);
      const bits = bytes.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || bits !== 16) return null;
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (id === "data") {
      if (sampleRate === 0) return null;
      const length = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Int16Array(length);
      for (let i = 0; i < length; i++) samples[i] = bytes.readInt16LE(body + i * 2);
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** `pcm` as a mono 16-bit PCM WAV file. */
export function pcmWavBytes(pcm: Pcm16): Buffer {
  const data = pcm.samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(pcm.sampleRate, 24);
  out.writeUInt32LE(pcm.sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.samples.length; i++) out.writeInt16LE(pcm.samples[i]!, 44 + i * 2);
  return out;
}

/** Input of {@link transcribeWindow}. */
export interface WindowRequest {
  /** Whole recording; the window is cut from it. */
  pcm: Pcm16;
  /** Window start, seconds on the recording's clock; clamped to the recording. */
  from: number;
  /** Window end (exclusive), seconds on the recording's clock; clamped to the recording. */
  to: number;
  /** Existing directory for the temporary window WAV. */
  dir: string;
  /** Provider call on a WAV path; times it returns are relative to that file. */
  transcribe(audio: string): Promise<{ words: readonly TranscriptWord[] }>;
}

/**
 * Re-transcribe `[from, to)` of a recording on its own: whisper decodes a
 * short window with fresh context, which recovers speech a full pass missed
 * (a phrase skipped mid-file, a repeat swallowed into one long word). Words
 * come back on the recording's clock. The window WAV is deleted afterwards.
 */
export async function transcribeWindow(request: WindowRequest): Promise<TranscriptWord[]> {
  const { pcm } = request;
  const first = Math.max(0, Math.floor(request.from * pcm.sampleRate));
  const last = Math.min(pcm.samples.length, Math.ceil(request.to * pcm.sampleRate));
  if (last <= first) return [];
  const offset = first / pcm.sampleRate;
  const path = join(request.dir, `window-${randomBytes(6).toString("hex")}.wav`);
  try {
    await writeFile(path, pcmWavBytes({ sampleRate: pcm.sampleRate, samples: pcm.samples.subarray(first, last) }));
    const result = await request.transcribe(path);
    return result.words.map((word) => ({ ...word, start: round(word.start + offset), end: round(word.end + offset) }));
  } finally {
    await rm(path, { force: true });
  }
}

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
