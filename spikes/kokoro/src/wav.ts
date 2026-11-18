// Writes takes as mono 16-bit PCM WAV with core's writer (`pcmWavBytes`), the format the SpeechProvider contract asks.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SAMPLE_RATE, toInt16 } from "./kokoro.ts";
import { built } from "./paths.ts";

export interface Pcm16 { sampleRate: number; samples: Int16Array }

const window = await built<{ pcmWavBytes(pcm: Pcm16): Buffer }>("packages/core/dist/transcripts/window.js");

export async function writeTake(path: string, samples: Float32Array): Promise<Pcm16> {
  const pcm = { sampleRate: SAMPLE_RATE, samples: toInt16(samples) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, window.pcmWavBytes(pcm));
  return pcm;
}
