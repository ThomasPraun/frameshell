// Live recognition for the teleprompter (ADR 0024 decision 5): a resident whisper-server fed the last 3.5 s of the
// microphone (mixed with system audio) every 0.5 s. Its words only move the teleprompter: nothing here is written to
// the project. The model is chosen once per machine by a speed check, kept in `dataDir`.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { dirname } from "node:path";
import type { LiveHeard, LiveStatus } from "../shared/api.js";

/** Sample rate of the audio the renderer sends and whisper reads, Hz. */
export const LIVE_SAMPLE_RATE = 16_000;
/** Seconds of audio per recognition, and between two (spike Q5/Q6: hop 0.5 s halves the follower's lag). */
export const LIVE_WINDOW_S = 3.5;
export const LIVE_HOP_S = 0.5;
/** Encoder context, frames of 20 ms: 8 s instead of 30, two to three times faster, no loss (spike Q5). */
export const LIVE_AUDIO_CONTEXT = 400;
/** Live models, preferred first. */
export const LIVE_MODELS = ["ggml-small-q5_1", "ggml-base-q5_1"] as const;
/** A machine taking longer than this per window with the first model gets the second: ~0.7 of the hop. */
export const LIVE_SLOW_MS = 350;
/** The server goes after this long with no audio and no warm-up, ms. */
const IDLE_MS = 10 * 60_000;
/** Model load and first-run shader compile (Metal: ~16 s cold) must fit. */
const READY_TIMEOUT_MS = 120_000;

/** One of {@link LIVE_MODELS}. */
export type LiveModel = (typeof LIVE_MODELS)[number];

/** Rolling mono 16-bit PCM, the newest {@link LIVE_WINDOW_S} seconds and a little more. */
export class PcmRing {
  readonly #data: Int16Array;
  #filled = 0;
  /** Samples appended since the last {@link take}. */
  fresh = 0;

  constructor(seconds = LIVE_WINDOW_S + 1, rate = LIVE_SAMPLE_RATE) {
    this.#data = new Int16Array(Math.round(seconds * rate));
  }

  append(samples: Int16Array): void {
    const size = this.#data.length;
    if (samples.length >= size) {
      this.#data.set(samples.subarray(samples.length - size));
      this.#filled = size;
    } else {
      const keep = Math.min(this.#filled, size - samples.length);
      this.#data.copyWithin(0, this.#filled - keep, this.#filled);
      this.#data.set(samples, keep);
      this.#filled = keep + samples.length;
    }
    this.fresh += samples.length;
  }

  /** The newest `seconds` (or all there is), and resets {@link fresh}. */
  take(seconds = LIVE_WINDOW_S, rate = LIVE_SAMPLE_RATE): Int16Array {
    this.fresh = 0;
    const count = Math.min(this.#filled, Math.round(seconds * rate));
    return this.#data.slice(this.#filled - count, this.#filled);
  }

  clear(): void {
    this.#filled = 0;
    this.fresh = 0;
  }
}

/** A mono 16-bit PCM WAV file. */
export function wavFile(samples: Int16Array, rate = LIVE_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.byteLength));
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.byteLength, true);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return bytes;
}

/**
 * Words of a whisper-server `verbose_json` reply for a window of `seconds`: one segment per word (`max_len` 1),
 * marks such as `[BLANK_AUDIO]` dropped; `silence` is the time after the last word.
 */
export function heardWords(reply: unknown, seconds: number): LiveHeard {
  const body = (reply ?? {}) as { segments?: { text?: unknown; end?: unknown }[]; language?: unknown };
  const words: string[] = [];
  let last = 0;
  for (const segment of body.segments ?? []) {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text || /^[[(].*[\])]$/.test(text) || !/[\p{L}\p{N}]/u.test(text)) continue;
    words.push(text);
    if (typeof segment.end === "number") last = Math.max(last, segment.end);
  }
  return { words, silence: Math.max(0, seconds - last), language: typeof body.language === "string" ? body.language : null };
}

/** whisper-server arguments: greedy decoding, no temperature fallback, the short encoder context (spike Q5). */
export function serverArgs(model: string, language: string, port: number, threads = Math.max(1, Math.min(4, cpus().length))): string[] {
  return ["-m", model, "-l", language, "-t", String(threads), "-bs", "1", "-bo", "1", "-nf", "-ac", String(LIVE_AUDIO_CONTEXT), "--host", "127.0.0.1", "--port", String(port)];
}

/** The live model after a speed check of `model` that took `ms` per window: the next smaller one when too slow. */
export function nextModel(model: LiveModel, ms: number): LiveModel {
  return ms > LIVE_SLOW_MS && model === LIVE_MODELS[0] ? LIVE_MODELS[1] : model;
}

/** Form fields of one recognition: per-word segments, no temperature fallback. */
function inferenceForm(samples: Int16Array, language: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([wavFile(samples)], { type: "audio/wav" }), "window.wav");
  for (const [key, value] of Object.entries({ response_format: "verbose_json", max_len: "1", split_on_word: "true", temperature: "0.0", temperature_inc: "0.0", language })) {
    form.append(key, value);
  }
  return form;
}

/** Quiet noise for warm-up and the speed check: the encoder costs the same whatever it hears. */
function noise(seconds: number): Int16Array {
  const samples = new Int16Array(Math.round(seconds * LIVE_SAMPLE_RATE));
  let seed = 1;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = (seed % 200) - 100;
  }
  return samples;
}

/** What {@link LiveRecognizer} needs from the app: managed installs, the choice file, process and network. */
export interface LiveDeps {
  /** Path of a runnable whisper-server; rejects with why there is none. */
  server(onProgress: (fraction: number | null) => void): Promise<string>;
  /** Path of managed model `id`. */
  model(id: LiveModel, onProgress: (fraction: number | null) => void): Promise<string>;
  /** Bytes still to download before the server can run model `id`; 0 when everything is installed. */
  missing(id: LiveModel): Promise<number>;
  /** File keeping the model chosen for this machine. */
  choiceFile: string;
  spawn?: typeof spawn;
  fetch?: typeof fetch;
}

/** The one whisper-server of the app: installs, starts, warms, picks the model, and recognizes windows of audio. */
export class LiveRecognizer {
  readonly #deps: LiveDeps;
  readonly #ring = new PcmRing();
  readonly #statusListeners = new Set<(status: LiveStatus) => void>();
  readonly #heardListeners = new Set<(heard: LiveHeard) => void>();
  #status: LiveStatus = { state: "off", model: null, detail: null, progress: null };
  #process: ChildProcess | null = null;
  #port = 0;
  #language = "auto";
  #warming: Promise<void> | null = null;
  #busy = false;
  #idle: NodeJS.Timeout | undefined;

  constructor(deps: LiveDeps) {
    this.#deps = deps;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => void this.#statusListeners.delete(listener);
  }

  onHeard(listener: (heard: LiveHeard) => void): () => void {
    this.#heardListeners.add(listener);
    return () => void this.#heardListeners.delete(listener);
  }

  /**
   * Start and warm the server for `language` (a code or `auto`); resolves with the status reached. What is not
   * installed yet is downloaded only with `install`: without, the status is `download` with the bytes it takes.
   */
  async warm(language: string, install = false): Promise<LiveStatus> {
    this.#touch();
    if (language !== this.#language && this.#process) this.#kill();
    this.#language = language;
    if (this.#status.state === "ready" && this.#process) return this.#status;
    if (!install && !this.#warming) {
      const model = (await this.#readChoice()) ?? LIVE_MODELS[0];
      const bytes = await this.#deps.missing(model).catch(() => 0);
      if (bytes > 0) {
        this.#set({ state: "download", model, detail: null, progress: null, bytes });
        return this.#status;
      }
    }
    this.#warming ??= this.#start().finally(() => (this.#warming = null));
    await this.#warming;
    return this.#status;
  }

  /** Append audio; recognizes the newest window once a hop of new audio came in and the server is free. */
  audio(samples: Int16Array): void {
    this.#touch();
    this.#ring.append(samples);
    if (this.#status.state !== "ready" || this.#busy || this.#ring.fresh < LIVE_HOP_S * LIVE_SAMPLE_RATE) return;
    const window = this.#ring.take();
    this.#busy = true;
    void this.#recognize(window)
      .then((heard) => {
        for (const listener of [...this.#heardListeners]) listener(heard);
      })
      .catch(() => undefined)
      .finally(() => (this.#busy = false));
  }

  /** Forget buffered audio: the next window starts from new sound. */
  reset(): void {
    this.#ring.clear();
  }

  /** Stop the server. */
  dispose(): void {
    clearTimeout(this.#idle);
    this.#kill();
    this.#set({ state: "off", model: null, detail: null, progress: null });
  }

  #touch(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.dispose(), IDLE_MS);
    this.#idle.unref?.();
  }

  #set(status: LiveStatus): void {
    this.#status = status;
    for (const listener of [...this.#statusListeners]) listener(status);
  }

  async #start(): Promise<void> {
    let model: LiveModel = LIVE_MODELS[0];
    try {
      const chosen = await this.#readChoice();
      model = chosen ?? LIVE_MODELS[0];
      const progress = (fraction: number | null) => this.#set({ state: "installing", model, detail: null, progress: fraction });
      progress(null);
      const server = await this.#deps.server(progress);
      await this.#launch(server, await this.#deps.model(model, progress), model);
      this.#set({ state: "warming", model, detail: null, progress: null });
      await this.#recognize(noise(1));
      if (!chosen) {
        const times: number[] = [];
        for (let run = 0; run < 2; run++) {
          const began = performance.now();
          await this.#recognize(noise(LIVE_WINDOW_S));
          times.push(performance.now() - began);
        }
        const ms = Math.min(...times);
        const next = nextModel(model, ms);
        if (next !== model) {
          model = next;
          this.#kill();
          await this.#launch(server, await this.#deps.model(model, progress), model);
          this.#set({ state: "warming", model, detail: null, progress: null });
          await this.#recognize(noise(1));
        }
        await this.#writeChoice({ model, ms: Math.round(ms), measuredAt: new Date().toISOString() });
      }
      this.#set({ state: "ready", model, detail: null, progress: null });
    } catch (error) {
      this.#kill();
      this.#set({ state: "unavailable", model: null, detail: (error as Error).message, progress: null });
    }
  }

  async #launch(server: string, modelPath: string, model: LiveModel): Promise<void> {
    this.#port = await freePort();
    const child = (this.#deps.spawn ?? spawn)(server, serverArgs(modelPath, this.#language, this.#port), {
      cwd: dirname(server),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.#process = child;
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => (tail = (tail + String(chunk)).slice(-2000)));
    const exited = new Promise<never>((_, reject) =>
      child.once("exit", (code) => {
        if (this.#process === child) {
          this.#process = null;
          if (this.#status.state === "ready") this.#set({ state: "unavailable", model: null, detail: `whisper-server stopped (${code})`, progress: null });
        }
        reject(new Error(`whisper-server exited (${code}) while starting ${model}: ${tail.trim().split("\n").slice(-3).join(" ")}`));
      }),
    );
    exited.catch(() => undefined);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await Promise.race([(this.#deps.fetch ?? fetch)(`http://127.0.0.1:${this.#port}/`), exited]);
        return;
      } catch (error) {
        if (this.#process !== child) throw error;
        if (Date.now() > deadline) throw new Error(`whisper-server did not answer in ${READY_TIMEOUT_MS / 1000} s`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  async #recognize(samples: Int16Array): Promise<LiveHeard> {
    const response = await (this.#deps.fetch ?? fetch)(`http://127.0.0.1:${this.#port}/inference`, {
      method: "POST",
      body: inferenceForm(samples, this.#language),
    });
    if (!response.ok) throw new Error(`whisper-server answered ${response.status}`);
    return heardWords(await response.json(), samples.length / LIVE_SAMPLE_RATE);
  }

  #kill(): void {
    const child = this.#process;
    this.#process = null;
    child?.kill();
  }

  async #readChoice(): Promise<LiveModel | null> {
    try {
      const { model } = JSON.parse(await readFile(this.#deps.choiceFile, "utf8")) as { model?: unknown };
      return LIVE_MODELS.find((candidate) => candidate === model) ?? null;
    } catch {
      return null;
    }
  }

  async #writeChoice(choice: { model: LiveModel; ms: number; measuredAt: string }): Promise<void> {
    await mkdir(dirname(this.#deps.choiceFile), { recursive: true });
    await writeFile(this.#deps.choiceFile, `${JSON.stringify(choice, null, 2)}\n`);
  }
}

/** What the app's IPC uses of a live recognizer: {@link LiveRecognizer}, or {@link standInLive} in e2e. */
export type LiveSource = Pick<LiveRecognizer, "status" | "onStatus" | "onHeard" | "warm" | "audio" | "reset" | "dispose">;

/**
 * Stand-in for e2e (`FRAMESHELL_SHOOT_STAND_IN=1`): ready at once, ignores audio, and hears what a test passes to
 * `globalThis.frameshellLiveHear(text, silence)` in the main process.
 */
export function standInLive(): LiveSource {
  let status: LiveStatus = { state: "off", model: null, detail: null, progress: null };
  const statusListeners = new Set<(status: LiveStatus) => void>();
  const heardListeners = new Set<(heard: LiveHeard) => void>();
  const set = (next: LiveStatus) => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };
  (globalThis as { frameshellLiveHear?: (text: string, silence?: number) => void }).frameshellLiveHear = (text, silence = 0) => {
    const heard: LiveHeard = { words: text.split(/\s+/).filter(Boolean), silence, language: null };
    for (const listener of [...heardListeners]) listener(heard);
  };
  return {
    get status() {
      return status;
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    onHeard: (listener) => {
      heardListeners.add(listener);
      return () => void heardListeners.delete(listener);
    },
    warm: async () => {
      if (status.state !== "ready") set({ state: "ready", model: "stand-in", detail: null, progress: null });
      return status;
    },
    audio: () => undefined,
    reset: () => undefined,
    dispose: () => set({ state: "off", model: null, detail: null, progress: null }),
  };
}

/** A TCP port free on the loopback interface now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
