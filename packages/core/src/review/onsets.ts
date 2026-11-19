import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Timeline } from "@frameshell/schema";
import { soundHits } from "../analyze/events.js";
import { EnvelopeBuilder, ENERGY_HOP_S } from "../media/energy.js";
import { wavData } from "../media/energy-store.js";
import { runTool } from "../media/ffmpeg.js";
import { soundsOn } from "../sound/place.js";
import { alignedAudioFilter } from "../media/recipe.js";
import { TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "../transcripts/audio.js";
import { findClicks } from "./sound.js";
import type { Onset } from "./sync.js";
import { CLICK_BAND_HZ, HARSH_BAND_HZ } from "./thresholds.js";

// The sound `review` reads: where sounds start, for the sync check (the anchors of generated takes on the
// timeline's audio tracks, or the hits found in an exported file's sound), and the decoded sound of a file for the
// sound review list. A timeline's sound is mixed only by `render`, so nothing else of it is heard here.

/** The generated takes (`sound.place`) on the audio tracks of `timeline`, at the second their anchor plays; a muted track or clip is not heard, so it is left out. */
export async function takeOnsets(root: string, timeline: Timeline): Promise<Onset[]> {
  const heard: Timeline = {
    ...timeline,
    tracks: timeline.tracks
      .filter((track) => !(track.kind === "audio" && track.muted === true))
      .map((track) => (track.kind === "audio" ? { ...track, clips: track.clips.filter((clip) => clip.audio?.muted !== true) } : track)),
  };
  return (await soundsOn(root, heard)).map((item) => ({ at: item.at, kind: item.kind }));
}

/**
 * The 10 ms envelope (dBFS per {@link ENERGY_HOP_S}) of the sound of `file`, decoded on the ingest clock so it lines up
 * with the picture. `scratch` is a folder the WAV goes in, removed afterwards.
 */
export async function fileEnvelope(ffmpeg: string, file: string, scratch: string): Promise<Float32Array> {
  const wav = join(scratch, "sound.wav");
  await mkdir(scratch, { recursive: true });
  try {
    await extractAudioWithFfmpeg({ path: file }, wav, async () => ffmpeg);
    const sound = wavData(await readFile(wav));
    const builder = new EnvelopeBuilder(sound.rate, sound.channels);
    builder.push(sound.data);
    return builder.finish();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The 10 ms envelope of the sound of `file` in {@link HARSH_BAND_HZ}, on the clock and at the rate of {@link fileEnvelope}
 * so the two line up hop for hop: two second-order high-passes and two low-passes in ffmpeg. `scratch` is removed afterwards.
 */
export async function fileBandEnvelope(ffmpeg: string, file: string, scratch: string, signal?: AbortSignal): Promise<Float32Array> {
  const wav = join(scratch, "band.wav");
  await mkdir(scratch, { recursive: true });
  try {
    const [low, high] = HARSH_BAND_HZ;
    const band = `${alignedAudioFilter(TRANSCRIPTION_SAMPLE_RATE)},highpass=f=${low},highpass=f=${low},lowpass=f=${high},lowpass=f=${high}`;
    await runTool(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-af", band, "-ac", "1", "-ar", String(TRANSCRIPTION_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", wav],
      signal ? { signal } : {},
    );
    const sound = wavData(await readFile(wav));
    const builder = new EnvelopeBuilder(sound.rate, sound.channels);
    builder.push(sound.data);
    return builder.finish();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Hits in a file's sound:the ones `analyze` reports as `hit` events (a 12 dB rise over the 80 ms before, in the 10 ms envelope, 150 ms apart). */
export function fileOnsets(envelope: Float32Array): Onset[] {
  return soundHits(envelope, ENERGY_HOP_S).map((hit) => ({ at: hit.time, kind: null }));
}

/** Sample rate the click check decodes at: enough for the band above {@link CLICK_BAND_HZ}. */
const CLICK_RATE = 48_000;

/**
 * Seconds of the clicks in the sound of `file` ({@link findClicks}): decoded at 48 kHz, folded to mono and kept above
 * {@link CLICK_BAND_HZ} by two second-order high-passes in ffmpeg. `scratch` is removed afterwards.
 */
export async function fileClicks(ffmpeg: string, file: string, scratch: string, signal?: AbortSignal): Promise<number[]> {
  const wav = join(scratch, "band.wav");
  await mkdir(scratch, { recursive: true });
  try {
    const band = `aresample=${CLICK_RATE},highpass=f=${CLICK_BAND_HZ},highpass=f=${CLICK_BAND_HZ}`;
    await runTool(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-af", band, "-ac", "1", "-ar", String(CLICK_RATE), "-c:a", "pcm_s16le", "-f", "wav", wav],
      signal ? { signal } : {},
    );
    const sound = wavData(await readFile(wav));
    // An Int16Array view needs an even byte offset; `data` is a Buffer, whose `slice` is a view, so copy it.
    const data = sound.data.byteOffset % 2 === 0 ? sound.data : new Uint8Array(sound.data);
    const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    return findClicks(samples, sound.rate);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
