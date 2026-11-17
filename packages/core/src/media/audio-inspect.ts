import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoudnessReading } from "../analyze/loudness.js";
import { SR } from "../sound/dsp.js";
import { integratedLoudness } from "../sound/loudness.js";
import { musicMarkOf, soundMarkOf } from "../sound/takes.js";
import { wavData } from "./energy-store.js";
import { runTool } from "./ffmpeg.js";
import { MIN_RANGE_SECONDS } from "./loudness-store.js";
import { alignedAudioFilter } from "./recipe.js";
import { runWorkerTask } from "../worker-task.js";
import { SPECTROGRAM_MAX_SECONDS, SPECTROGRAM_RATE, type Spectrogram } from "./spectrogram.js";

/** Bytes read from the head of a WAV for its `fssd` mark: it sits between `fmt ` and `data`, well inside this. */
const MARK_HEAD_BYTES = 64 * 1024;
/** Worker script of the spectrogram; from the sources (tests), the built copy. */
const SPECTROGRAM_WORKER = import.meta.url.endsWith(".ts") ? new URL("../../dist/media/spectrogram-worker.js", import.meta.url) : new URL("./spectrogram-worker.js", import.meta.url);
/** Files `audio.inspect` reads at once. */
export const AUDIO_INSPECT_LANES = 3;
/** Spectrograms kept in memory per inspector (about 100 KB each). */
const MEMORY_ENTRIES = 32;

/** What made a generated take, from its `fssd` mark (ADR 0038). */
export interface TakeFacts {
  /** A sound effect kind, or `music`. */
  kind: string;
  seed: number;
  /** Sound effects: the recipe, 1 to 3; null for music. */
  variant: number | null;
  /** Music: the preset; null for sound effects. */
  preset: string | null;
  /** Music: the tempo; null for sound effects. */
  bpm: number | null;
}

/** One file as `audio.inspect` reports it. */
export interface AudioFacts {
  asset: string;
  /** Seconds; null when the file does not say. */
  duration: number | null;
  /** Integrated loudness, LUFS; null for silence. See {@link AudioFacts.shortSound}. */
  lufs: number | null;
  /**
   * The sound is shorter than one 400 ms gating block of EBU R128, which reads it as silence: `lufs` is then the loudness
   * of the one block that holds it (the sound padded with silence), measured here by the synth's BS.1770 meter.
   */
  shortSound: boolean;
  /** True peak of the loudest channel, dBTP; null for digital silence. */
  truePeak: number | null;
  /** Loudness range, LU; null for silence. */
  range: number | null;
  take: TakeFacts | null;
  spectrogram: Spectrogram | null;
}

/** What {@link AudioInspector} reads through. */
export interface AudioInspectorOptions {
  /** The cached EBU R128 reading (`LoudnessStore.reading`): never measured twice. */
  loudness(root: string, rel: string): Promise<LoudnessReading>;
  /** Content hash of an asset (`MediaService.derivedAudio`), the memory key of its spectrogram. */
  hash(root: string, rel: string): Promise<string>;
  duration(root: string, rel: string): Promise<number | null>;
  ffmpeg(root: string): Promise<string>;
}

/**
 * Facts of sound files for an audition (`audio.inspect`): loudness from the loudness cache, the mark of a generated
 * take, and on request a spectrogram. The spectrogram is computed per call, not cached on disk: decoding and the FFT
 * (in a worker thread) took about 1.2 s for 27 s of music and 1.7 s for a 3 min MP3 on a busy Windows machine, most of
 * it ffmpeg; the last few are kept in memory, so reopening an audition does not decode again.
 */
export class AudioInspector {
  readonly #options: AudioInspectorOptions;
  readonly #memory = new Map<string, Promise<Spectrogram>>();

  constructor(options: AudioInspectorOptions) {
    this.#options = options;
  }

  /** Facts of project-relative `rel`. Throws what the loudness reading throws (InvalidOperation for a file with no sound). */
  async inspect(root: string, rel: string, withSpectrogram: boolean): Promise<AudioFacts> {
    const reading = await this.#options.loudness(root, rel);
    const file = join(root, ...rel.split("/"));
    const [duration, take, picture] = await Promise.all([
      this.#options.duration(root, rel).catch(() => null),
      takeFacts(file),
      withSpectrogram ? this.#spectrogram(root, rel) : null,
    ]);
    // A click or a pop is shorter than a gating block: silence to EBU R128, but not to the ear.
    const short = reading.integrated === null && reading.truePeak !== null && duration !== null && duration < MIN_RANGE_SECONDS;
    const lufs = short ? await blockLoudness(await this.#options.ffmpeg(root), file) : reading.integrated;
    return { asset: rel, duration, lufs, shortSound: short && lufs !== null, truePeak: reading.truePeak, range: reading.range, take, spectrogram: picture };
  }

  async #spectrogram(root: string, rel: string): Promise<Spectrogram> {
    const key = `${root}\0${await this.#options.hash(root, rel)}`;
    let picture = this.#memory.get(key);
    if (!picture) {
      picture = this.#options.ffmpeg(root).then((ffmpeg) => pictureOf(ffmpeg, join(root, ...rel.split("/"))));
      this.#memory.set(key, picture);
      picture.catch(() => this.#memory.delete(key));
      if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
    }
    return picture;
  }
}

/**
 * Loudness of the sound of `file`, shorter than one gating block, as that block: decoded at 48 kHz, each channel padded
 * with silence to {@link MIN_RANGE_SECONDS}, through BS.1770 (`integratedLoudness`). LUFS to 0.1, null for silence.
 */
async function blockLoudness(ffmpeg: string, file: string): Promise<number | null> {
  const scratch = await mkdtemp(join(tmpdir(), "frameshell-loudness-"));
  try {
    const wav = join(scratch, "sound.wav");
    await runTool(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-af", alignedAudioFilter(SR), "-c:a", "pcm_s16le", wav]);
    const { channels, data } = wavData(await readFile(wav));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const frames = Math.floor(data.byteLength / (2 * channels));
    const block = Math.round(MIN_RANGE_SECONDS * SR);
    const padded = Array.from({ length: channels }, (_, channel) => {
      const samples = new Float64Array(Math.max(block, frames));
      for (let i = 0; i < frames; i++) samples[i] = view.getInt16((i * channels + channel) * 2, true) / 32768;
      return samples;
    });
    const lufs = integratedLoudness(padded);
    return Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The facts in the `fssd` mark of the WAV at `path`; null for any other file. */
export async function takeFacts(path: string): Promise<TakeFacts | null> {
  if (!path.toLowerCase().endsWith(".wav")) return null;
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(MARK_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, MARK_HEAD_BYTES, 0);
    const bytes = head.subarray(0, bytesRead);
    const music = musicMarkOf(bytes);
    if (music) return { kind: "music", seed: music.seed, variant: null, preset: music.preset, bpm: music.bpm };
    const sfx = soundMarkOf(bytes);
    return sfx ? { kind: sfx.kind, seed: sfx.seed, variant: sfx.variant, preset: null, bpm: null } : null;
  } finally {
    await handle.close();
  }
}

/**
 * The spectrogram of the first {@link SPECTROGRAM_MAX_SECONDS} of the sound of `file`, folded to mono at
 * {@link SPECTROGRAM_RATE} by ffmpeg into a temp WAV and read in a worker thread.
 */
async function pictureOf(ffmpeg: string, file: string): Promise<Spectrogram> {
  const scratch = await mkdtemp(join(tmpdir(), "frameshell-spectrogram-"));
  try {
    const wav = join(scratch, "sound.wav");
    await runTool(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-t", String(SPECTROGRAM_MAX_SECONDS)],
      ...["-af", alignedAudioFilter(SPECTROGRAM_RATE), "-ac", "1", "-c:a", "pcm_s16le", wav],
    ]);
    return await runWorkerTask<Spectrogram>(SPECTROGRAM_WORKER, wav, "spectrogram", {});
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
