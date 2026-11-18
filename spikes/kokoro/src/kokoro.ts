// Kokoro-82M on the managed ONNX Runtime Web through core's one loader (`loadOnnxModel`, single-threaded WASM).
// Phonemes -> token ids (tokenizer.json vocab), style row by token count, 24 kHz float waveform out.
import { readFileSync } from "node:fs";
import { ORT_RUNTIME, built } from "./paths.ts";
import { MODELS, local } from "./pins.ts";

/** Kokoro's output rate. */
export const SAMPLE_RATE = 24_000;
/** Context is 512 ids: 510 phoneme tokens plus the pad id 0 at each end. */
export const MAX_TOKENS = 510;

interface Loader {
  loadOnnxModel(runtime: string, model: string): Promise<{ ort: any; session: any }>;
}

let vocab: Map<string, number> | null = null;

/** Token ids of `phonemes`; characters outside the vocabulary are dropped (and returned for the report). */
export function tokenize(phonemes: string): { ids: number[]; dropped: string[] } {
  vocab ??= new Map(
    Object.entries((JSON.parse(readFileSync(local("tokenizer.json"), "utf8")) as { model: { vocab: Record<string, number> } }).model.vocab),
  );
  const ids: number[] = [];
  const dropped: string[] = [];
  for (const char of phonemes) {
    const id = vocab.get(char);
    if (id === undefined) dropped.push(char);
    else ids.push(id);
  }
  return { ids, dropped };
}

/** The voice pack: 510 style rows of 256 floats, row n for an input of n tokens. */
export function loadVoice(name: string): Float32Array {
  const bytes = readFileSync(local(`voices/${name}.bin`));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

/**
 * Chunks of at most MAX_TOKENS tokens, cut at sentence ends first, then at commas, then at spaces: Kokoro reads one
 * chunk per run and the chunks' audio is joined.
 */
export function chunk(phonemes: string): string[] {
  const fits = (s: string) => tokenize(s).ids.length <= MAX_TOKENS;
  if (fits(phonemes)) return [phonemes];
  const split = (text: string, by: RegExp): string[] => {
    const pieces = text.split(by).filter((p) => p.trim() !== "");
    const out: string[] = [];
    let current = "";
    for (const piece of pieces) {
      const joined = current === "" ? piece : `${current} ${piece}`;
      if (fits(joined)) current = joined;
      else {
        if (current !== "") out.push(current);
        current = piece;
      }
    }
    if (current !== "") out.push(current);
    return out;
  };
  return split(phonemes, /(?<=[.!?;:…])\s+/).flatMap((s) => (fits(s) ? [s] : split(s, /(?<=,)\s+/).flatMap((c) => (fits(c) ? [c] : split(c, /\s+/)))));
}

/** A loaded model variant. */
export class Kokoro {
  private readonly ort: any;
  private readonly session: any;
  readonly loadMs: number;

  private constructor(ort: any, session: any, loadMs: number) {
    this.ort = ort;
    this.session = session;
    this.loadMs = loadMs;
  }

  static async load(variant: string): Promise<Kokoro> {
    const pin = MODELS[variant];
    if (!pin) throw new Error(`Unknown variant ${variant}`);
    const { loadOnnxModel } = await built<Loader>("packages/core/dist/onnx-web.js");
    const started = performance.now();
    const { ort, session } = await loadOnnxModel(ORT_RUNTIME, local(pin.file));
    return new Kokoro(ort, session, performance.now() - started);
  }

  get io(): { inputs: readonly string[]; outputs: readonly string[] } {
    return { inputs: this.session.inputNames, outputs: this.session.outputNames };
  }

  /** One run: at most MAX_TOKENS tokens. */
  async run(ids: readonly number[], voice: Float32Array, speed = 1): Promise<Float32Array> {
    if (ids.length > MAX_TOKENS) throw new Error(`${ids.length} tokens > ${MAX_TOKENS}`);
    const row = Math.min(ids.length, voice.length / 256 - 1);
    const padded = BigInt64Array.from([0, ...ids, 0].map((id) => BigInt(id)));
    const feeds = {
      input_ids: new this.ort.Tensor("int64", padded, [1, padded.length]),
      style: new this.ort.Tensor("float32", voice.slice(row * 256, row * 256 + 256), [1, 256]),
      speed: new this.ort.Tensor("float32", new Float32Array([speed]), [1]),
    };
    const out = await this.session.run(feeds);
    return out[this.session.outputNames[0]].data as Float32Array;
  }

  /** Whole text of phonemes, chunked; returns samples and how many runs it took. */
  async speak(phonemes: string, voice: Float32Array, speed = 1): Promise<{ samples: Float32Array; chunks: number; tokens: number }> {
    const pieces = chunk(phonemes);
    const parts: Float32Array[] = [];
    let tokens = 0;
    for (const piece of pieces) {
      const { ids } = tokenize(piece);
      tokens += ids.length;
      parts.push(await this.run(ids, voice, speed));
    }
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    return { samples, chunks: pieces.length, tokens };
  }
}

/** Mono 16-bit samples of a float waveform (clipped). */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767)));
  return out;
}
