import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetInfo } from "@frameshell/protocol";
import { writeTextAtomic } from "../fs-util.js";
import { type AudioExtractor, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "../transcripts/audio.js";
import { type EnergyProfile, EnvelopeBuilder, energyProfile } from "./energy.js";

/** Project-relative cache directory of energy envelopes (regenerable). */
export const ENERGY_DIR = ".frameshell/energy";
/** Bump when the envelope computation changes: it is part of the cache file name. */
const ENERGY_VERSION = 1;
/** Profiles kept in memory per store (~720 KB per 30 min of audio). */
const MEMORY_ENTRIES = 32;

/** Options for {@link EnergyStore}. */
export interface EnergyStoreOptions {
  /** Content hash and PCM sidecar of an asset; see `MediaService.derivedAudio`. */
  derivedAudio(root: string, rel: string): Promise<{ hash: string; sidecar: AssetInfo["sidecar"] }>;
  /** Managed or overridden ffmpeg for the project; only run when there is no sidecar. */
  ffmpeg(root: string): Promise<string>;
  /** Decoder of assets without sidecar. Default: ffmpeg on the ingest clock. */
  extractAudio?: AudioExtractor | undefined;
}

/**
 * Per-asset energy envelopes for cut snapping (#12), cached by content hash
 * in `.frameshell/energy/`. Source: the ingest PCM sidecar when present,
 * else the asset decoded by ffmpeg on the same clock, so snapping never
 * waits for ingest.
 */
export class EnergyStore {
  readonly #options: EnergyStoreOptions;
  readonly #memory = new Map<string, Promise<EnergyProfile>>();

  constructor(options: EnergyStoreOptions) {
    this.#options = options;
  }

  /** Energy profile of project-relative `rel`. Throws when the asset cannot be read or decoded. */
  async profile(root: string, rel: string): Promise<EnergyProfile> {
    const { hash, sidecar } = await this.#options.derivedAudio(root, rel);
    const key = `${root}\0${hash}`;
    let profile = this.#memory.get(key);
    if (!profile) {
      profile = this.#load(root, rel, hash, sidecar);
      this.#memory.set(key, profile);
      profile.catch(() => this.#memory.delete(key));
      if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
    }
    return profile;
  }

  async #load(root: string, rel: string, hash: string, sidecar: AssetInfo["sidecar"]): Promise<EnergyProfile> {
    const cache = join(root, ...ENERGY_DIR.split("/"), `${hash.replace(/^sha256:/, "").slice(0, 20)}-e${ENERGY_VERSION}.f32`);
    const cached = await readFile(cache).catch(() => null);
    if (cached && cached.length > 0 && cached.length % 4 === 0) return energyProfile(decodeFloats(cached));
    const db = sidecar ? await envelopeOfPcm(join(root, ...sidecar.path.split("/")), sidecar) : await this.#decode(root, rel);
    await writeTextAtomic(cache, encodeFloats(db));
    return energyProfile(db);
  }

  /** Decode `rel` to a temp 16 kHz mono WAV and measure it. */
  async #decode(root: string, rel: string): Promise<Float32Array> {
    const temp = join(root, ...ENERGY_DIR.split("/"), `.decode-${randomUUID().slice(0, 8)}.wav`);
    const extract = this.#options.extractAudio ?? extractAudioWithFfmpeg;
    try {
      await mkdir(dirname(temp), { recursive: true });
      await extract({ path: join(root, ...rel.split("/")) }, temp, () => this.#options.ffmpeg(root));
      const { rate, channels, data } = wavData(await readFile(temp));
      const builder = new EnvelopeBuilder(rate, channels);
      builder.push(data);
      return builder.finish();
    } finally {
      await rm(temp, { force: true });
    }
  }
}

async function envelopeOfPcm(path: string, layout: { sampleRate: number; channels: number }): Promise<Float32Array> {
  const builder = new EnvelopeBuilder(layout.sampleRate, layout.channels);
  for await (const chunk of createReadStream(path)) builder.push(chunk as Buffer);
  return builder.finish();
}

/** Format and data chunk of a 16-bit PCM WAV. Throws when it is not one. */
function wavData(bytes: Buffer): { rate: number; channels: number; data: Uint8Array } {
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let rate = TRANSCRIPTION_SAMPLE_RATE;
  let channels = 1;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(body + 2);
      rate = bytes.readUInt32LE(body + 4);
    } else if (id === "data") {
      // Streamed WAVs may carry a placeholder size: take what is there.
      return { rate, channels, data: bytes.subarray(body, Math.min(bytes.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

function encodeFloats(values: Float32Array): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
}

function decodeFloats(bytes: Buffer): Float32Array {
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}
