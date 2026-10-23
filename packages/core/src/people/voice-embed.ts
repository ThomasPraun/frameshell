// CAM++ speaker embeddings (ADR 0020 decision 3): fbank features in TypeScript, the model on ONNX Runtime
// Web in a worker thread, one 512-value embedding per stretch of a transcription WAV.
import { Worker } from "node:worker_threads";
import { loadOnnxModel } from "../onnx-web.js";
import { readPcmWav } from "../transcripts/window.js";
import { FBANK_BINS, FBANK_SAMPLE_RATE, fbank, subtractMean } from "./fbank.js";

/** A stretch of audio, source seconds. */
export interface Stretch {
  start: number;
  end: number;
}

/** What a {@link VoiceEmbedder} embeds: stretches of one 16 kHz mono WAV. */
export interface VoiceEmbedRequest {
  /** Absolute path of the transcription WAV. */
  audio: string;
  stretches: Stretch[];
  signal?: AbortSignal | undefined;
  /** 0..1 of the stretches done. */
  onProgress?: ((fraction: number) => void) | undefined;
}

/** One speaker embedding per stretch, in request order. */
export type VoiceEmbedder = (request: VoiceEmbedRequest) => Promise<number[][]>;

/** Files the voice worker loads: ONNX Runtime Web's module and the CAM++ model. */
export interface CampplusFiles {
  runtime: string;
  model: string;
}

/**
 * Embed each stretch of `audio` with the CAM++ model at `files.model`, in
 * this thread. Each stretch is one utterance for the features' mean
 * subtraction, as sherpa-onnx embeds one diarized segment.
 */
export async function embedStretches(files: CampplusFiles, audio: string, stretches: readonly Stretch[], onProgress?: (fraction: number) => void): Promise<number[][]> {
  const pcm = await readPcmWav(audio);
  if (!pcm) throw new Error(`${audio} is not a 16-bit mono PCM WAV`);
  if (pcm.sampleRate !== FBANK_SAMPLE_RATE) throw new Error(`${audio} is ${pcm.sampleRate} Hz; voice prints need ${FBANK_SAMPLE_RATE} Hz`);
  const { ort, session } = await loadOnnxModel(files.runtime, files.model);
  const input = session.inputNames[0] ?? "x";
  const output = session.outputNames[0] ?? "embedding";
  const embeddings: number[][] = [];
  for (const [index, stretch] of stretches.entries()) {
    const from = Math.max(0, Math.round(stretch.start * pcm.sampleRate));
    const to = Math.min(pcm.samples.length, Math.round(stretch.end * pcm.sampleRate));
    const samples = new Float32Array(Math.max(0, to - from));
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.samples[from + i]! / 32768;
    const features = subtractMean(fbank(samples));
    if (features.frames === 0) throw new Error(`stretch ${stretch.start}-${stretch.end} s of ${audio} has no audio`);
    const result = await session.run({ [input]: new ort.Tensor("float32", features.data, [1, features.frames, FBANK_BINS]) });
    embeddings.push(Array.from(result[output]!.data as Float32Array));
    onProgress?.((index + 1) / stretches.length);
  }
  return embeddings;
}

/** Messages from `voice-worker.js`. */
export type VoiceWorkerMessage = { type: "progress"; fraction: number } | { type: "done"; embeddings: number[][] } | { type: "error"; message: string };

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const VOICE_WORKER = import.meta.url.endsWith(".ts")
  ? new URL("../../dist/people/voice-worker.js", import.meta.url)
  : new URL("./voice-worker.js", import.meta.url);

/**
 * {@link VoiceEmbedder} running CAM++ in a worker thread per request, so
 * features and inference never block the daemon's event loop. Aborting
 * terminates it.
 */
export function campplusWorkerEmbedder(files: CampplusFiles): VoiceEmbedder {
  return ({ audio, stretches, signal, onProgress }) =>
    new Promise<number[][]>((resolve, reject) => {
      signal?.throwIfAborted();
      const worker = new Worker(VOICE_WORKER, { workerData: { ...files, audio, stretches } });
      const abort = () => {
        void worker.terminate();
        reject(signal!.reason as Error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => signal?.removeEventListener("abort", abort);
      worker.on("message", (message: VoiceWorkerMessage) => {
        if (message.type === "progress") return onProgress?.(message.fraction);
        settle();
        void worker.terminate();
        if (message.type === "done") resolve(message.embeddings);
        else reject(new Error(message.message));
      });
      worker.once("error", (error) => {
        settle();
        reject(error);
      });
      // A promise settles once: after a result this rejection is ignored.
      worker.once("exit", (code) => {
        settle();
        reject(new Error(`voice print worker exited (code ${code}) without a result`));
      });
    });
}
