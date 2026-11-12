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
  return pcmOfWav(bytes);
}

/** {@link readPcmWav} on bytes already read. */
export function pcmOfWav(bytes: Buffer): Pcm16 | null {
  let sampleRate = 0;
  for (const { id, body, size } of riffChunks(bytes)) {
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
  }
  return null;
}

/** Body of the first chunk `id` (4 ASCII characters) of a WAV file before its `data` chunk; null when absent or not a WAV. */
export function wavChunk(bytes: Buffer, id: string): Buffer | null {
  for (const chunk of riffChunks(bytes)) {
    if (chunk.id === id) return bytes.subarray(chunk.body, Math.min(bytes.length, chunk.body + chunk.size));
    if (chunk.id === "data") return null;
  }
  return null;
}

/** Top-level chunks of a RIFF WAVE file in order; none when `bytes` is not one. Sizes may run past the end. */
function* riffChunks(bytes: Buffer): Generator<{ id: string; body: number; size: number }> {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(offset + 4);
    yield { id: bytes.toString("ascii", offset, offset + 4), body: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
}

/** Integer PCM audio of any channel count, to write as a WAV file with {@link wavBytes}. */
export interface PcmWav {
  /** Samples per second. */
  sampleRate: number;
  /** Bits per sample: samples are 16-bit or signed 24-bit integers. */
  bits: 16 | 24;
  /** One array per channel, all of one length; 24-bit samples are held in an `Int32Array`. */
  channels: readonly (Int16Array | Int32Array)[];
}

/**
 * `audio` as a PCM WAV file. `chunks` (4-character ASCII ids) go between `fmt ` and `data`, where
 * WAV readers skip chunks they do not know.
 */
export function wavBytes(audio: PcmWav, chunks: readonly { id: string; body: Uint8Array }[] = []): Buffer {
  const { bits, channels, sampleRate } = audio;
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const width = bits / 8;
  const data = frames * count * width;
  const extra = chunks.map(({ id, body }) => {
    const chunk = Buffer.alloc(8 + body.length + (body.length % 2));
    chunk.write(id, 0, 4, "ascii");
    chunk.writeUInt32LE(body.length, 4);
    chunk.set(body, 8);
    return chunk;
  });
  const head = Buffer.alloc(36);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + extra.reduce((total, chunk) => total + chunk.length, 0) + data, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(count, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * count * width, 28);
  head.writeUInt16LE(count * width, 32);
  head.writeUInt16LE(bits, 34);
  const body = Buffer.alloc(8 + data);
  body.write("data", 0, "ascii");
  body.writeUInt32LE(data, 4);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < count; channel++) {
      const at = 8 + (frame * count + channel) * width;
      const sample = channels[channel]![frame]!;
      if (bits === 16) body.writeInt16LE(sample, at);
      else body.writeIntLE(sample, at, 3);
    }
  }
  return Buffer.concat([head, ...extra, body]);
}

/** `pcm` as a mono 16-bit PCM WAV file; see {@link wavBytes}. */
export function pcmWavBytes(pcm: Pcm16, chunks: readonly { id: string; body: Uint8Array }[] = []): Buffer {
  return wavBytes({ sampleRate: pcm.sampleRate, bits: 16, channels: [pcm.samples] }, chunks);
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
