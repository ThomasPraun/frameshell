// Preview engine (ADR 0001, SPEC §3.4): decodes proxies with WebCodecs and draws to an OffscreenCanvas on the audio
// clock, and feeds program audio from PCM sidecars to the AudioWorklet. Runs in a Worker: main-thread (React) stalls
// must not freeze the picture.
import { type AudioRead, audioReads, renderRead, sourceWindow } from "./audio-plan.js";
import { type DecodeStep, decodeSteps } from "./decode-plan.js";
import { type ProxyIndex, openProxy, readSamples } from "./demux.js";
import {
  type Anchor,
  type ClockSample,
  type EngineStats,
  type FromEngine,
  type ToEngine,
  type ToMixer,
  heardTime,
  programSample,
} from "./engine-protocol.js";
import { type Program, firstAudioDifference, firstVideoDifference, programAt } from "./program.js";

/** DedicatedWorkerGlobalScope, as far as the engine uses it (the DOM lib types `self` as Window). */
interface WorkerScope {
  postMessage(message: FromEngine): void;
  onmessage: ((event: MessageEvent<ToEngine>) => void) | null;
  requestAnimationFrame(callback: (time: number) => void): number;
}
const scope = self as unknown as WorkerScope;

/** Decoded frames kept ahead of the playhead (decoder queue included): ~0.4 s at 30 fps, as measured in ADR 0001. */
const MAX_AHEAD = 12;
/** Proxy samples fetched per ranged read: two GOPs. */
const READ_SAMPLES = 30;
/** Audio scheduled this far ahead of what is heard. */
const AUDIO_HORIZON_S = 2;
/** Program samples per audio chunk sent to the mixer (0.5 s). */
const AUDIO_CHUNK = 24_000;
/** A live change cuts the audio no sooner than this after what is heard: the mixer renders ahead of the speakers. */
const CUT_MARGIN_S = 0.25;
/** Stats are posted this often. */
const STATS_MS = 1000;

interface Ready {
  from: number;
  to: number;
  frame: VideoFrame;
}

interface Pending {
  from: number;
  to: number;
  gen: number;
}

/** A sidecar read in flight; `limit` (program sample) trims it when a cut or stop overtakes it. */
interface AudioJob {
  limit: number;
}

type Step = { step: DecodeStep; proxy: string; index: ProxyIndex; data: Uint8Array };

class Engine {
  readonly #canvas: OffscreenCanvas;
  readonly #context: OffscreenCanvasRenderingContext2D;
  readonly #mediaUrl: string;
  #audio: MessagePort | null = null;
  #program: Program | null = null;

  readonly #proxies = new Map<string, Promise<ProxyIndex>>();
  #decoder: VideoDecoder | null = null;
  /** Proxy the decoder is configured for; null after reset or error. */
  #configured: string | null = null;
  /** Bumped on every pipeline restart: outputs and reads of older generations are dropped. */
  #gen = 0;
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  /** Decoded frames in program order. */
  #ready: Ready[] = [];
  #feeder: AsyncGenerator<Step> | null = null;
  #pumping = false;
  /** Program frame after the last one handed to the decoder. */
  #fedUntil = 0;

  #anchor: Anchor | null = null;
  #clock: ClockSample | null = null;
  /** First program frame of the current play: shown until the clock reaches it. */
  #playFrom = 0;
  #pausedFrame = 0;
  /** What the canvas holds: `f<from>` for a decoded frame, `black`, or `` (must redraw). */
  #drawn = "";
  #shown = Number.NaN;
  #tickQueued = false;

  /** Program sample up to which audio has been requested. */
  #audioUntil = 0;
  /** Audio requested from here on fades in here (play start, live cut) unless its clip starts later. */
  #audioFadeFloor = 0;
  readonly #audioJobs = new Set<AudioJob>();

  readonly stats: EngineStats = { decoded: 0, discarded: 0, drawn: 0, starved: 0, restarts: 0, audioChunks: 0 };

  constructor(canvas: OffscreenCanvas, mediaUrl: string) {
    this.#canvas = canvas;
    this.#context = canvas.getContext("2d", { alpha: false })!;
    this.#mediaUrl = mediaUrl;
    this.#context.fillStyle = "#000";
    this.#context.fillRect(0, 0, canvas.width, canvas.height);
    setInterval(() => scope.postMessage({ type: "stats", stats: { ...this.stats } }), STATS_MS);
  }

  handle(message: ToEngine): void {
    switch (message.type) {
      case "audio":
        this.#audio = message.port;
        break;
      case "size":
        if (this.#canvas.width !== message.width || this.#canvas.height !== message.height) {
          this.#canvas.width = message.width;
          this.#canvas.height = message.height;
          this.#drawn = "";
          this.#queueTick();
        }
        break;
      case "program":
        this.#setProgram(message.program);
        break;
      case "clock":
        this.#clock = message.sample;
        break;
      case "play":
        this.#play(message.anchor, message.clock);
        break;
      case "pause":
        this.#stopAudio();
        this.#anchor = null;
        this.#moveTo(message.frame);
        break;
      case "seek":
        this.#moveTo(message.frame);
        break;
      case "init":
        break;
    }
  }

  // ---------- clock ----------

  #nowSample(): number {
    const program = this.#program!;
    return programSample(this.#anchor!, heardTime(this.#clock!, performance.timeOrigin + performance.now()), program.sampleRate);
  }

  #wantFrame(): number {
    const program = this.#program!;
    let frame = this.#pausedFrame;
    if (this.#anchor && this.#clock) {
      frame = Math.max(this.#playFrom, Math.floor((this.#nowSample() / program.sampleRate) * program.fps + 1e-6));
    }
    return Math.max(0, Math.min(frame, program.frames - 1));
  }

  #play(anchor: Anchor, clock: ClockSample): void {
    const program = this.#program;
    if (!program) return;
    this.#stopAudio();
    this.#clock = clock;
    const from = Math.floor((anchor.sample / program.sampleRate) * program.fps + 1e-6);
    this.#moveTo(from);
    this.#anchor = anchor;
    this.#playFrom = from;
    this.#audioUntil = anchor.sample;
    this.#audioFadeFloor = anchor.sample;
    this.#scheduleAudio();
    this.#queueTick();
  }

  // ---------- program ----------

  #setProgram(next: Program): void {
    const previous = this.#program;
    this.#program = next;
    for (const span of next.video) if (span.kind === "media") void this.#index(span.proxy).catch(() => undefined);
    if (!previous) {
      this.#restart(this.#pausedFrame, false);
      return;
    }
    const current = this.#anchor ? this.#wantFrame() : this.#pausedFrame;
    const video = firstVideoDifference(previous, next, current);
    if (video !== Infinity) {
      if (!this.#anchor && video <= this.#pausedFrame) {
        this.#drawn = "";
        this.#restart(this.#pausedFrame, false);
      } else {
        this.#restartKeeping(this.#anchor ? Math.max(video, current + 1) : video);
      }
    }
    if (this.#anchor && this.#audio) {
      const now = this.#nowSample();
      const audio = firstAudioDifference(previous, next, Math.floor(now));
      if (audio < this.#audioUntil) {
        const cut = Math.max(audio, Math.ceil(now + CUT_MARGIN_S * next.sampleRate));
        for (const job of this.#audioJobs) job.limit = Math.min(job.limit, cut);
        this.#post({ type: "cut", at: this.#toContext(cut) });
        this.#audioUntil = cut;
        this.#audioFadeFloor = cut;
      }
    }
    this.#queueTick();
  }

  // ---------- video pipeline ----------

  /** Show program frame `frame` while paused (or as the first frame of a play). */
  #moveTo(frame: number): void {
    this.#pausedFrame = frame;
    const hit = this.#ready.findIndex((r) => r.from <= frame && frame < r.to);
    if (hit >= 0) {
      for (const stale of this.#ready.splice(0, hit)) this.#close(stale);
    } else {
      this.#restart(frame, false);
    }
    this.#queueTick();
  }

  /** Restart decoding at `frame`, keeping decoded frames before `limit` when `keep`. */
  #restart(frame: number, keep: boolean, limit = frame): void {
    this.#gen++;
    this.stats.restarts++;
    const kept: Ready[] = [];
    for (const ready of this.#ready) {
      if (keep && ready.from < limit) {
        ready.to = Math.min(ready.to, limit);
        kept.push(ready);
      } else this.#close(ready);
    }
    this.#ready = kept;
    this.#pending.clear();
    if (this.#decoder && this.#decoder.state === "configured") this.#decoder.reset();
    this.#configured = null;
    void this.#feeder?.return(undefined);
    this.#fedUntil = frame;
    this.#feeder = this.#program ? this.#steps(this.#program, frame, this.#gen) : null;
    void this.#pump();
  }

  /**
   * The program changed from frame `frame` on: keep what is decoded before
   * it, decode the rest again. Frames still in the decoder are lost on reset,
   * so decoding restarts at the first of those if it comes earlier.
   */
  #restartKeeping(frame: number): void {
    let from = Math.min(frame, this.#fedUntil);
    for (const pending of this.#pending.values()) if (pending.gen === this.#gen) from = Math.min(from, pending.from);
    this.#restart(from, true);
  }

  async *#steps(program: Program, from: number, gen: number): AsyncGenerator<Step> {
    for (const span of program.video) {
      if (span.end <= from || span.kind !== "media") continue;
      let index: ProxyIndex;
      try {
        index = await this.#index(span.proxy);
      } catch (error) {
        this.#error(`Cannot read ${span.proxy}: ${(error as Error).message}`);
        continue;
      }
      if (gen !== this.#gen) return;
      let block: { start: number; bytes: Uint8Array[] } | null = null;
      for (const step of decodeSteps(span, from, index.table)) {
        if (!block || step.sample < block.start || step.sample >= block.start + block.bytes.length) {
          const bytes = await readSamples(index, step.sample, step.sample + READ_SAMPLES, this.#reader(span.proxy));
          if (gen !== this.#gen) return;
          block = { start: step.sample, bytes };
        }
        yield { step, proxy: span.proxy, index, data: block.bytes[step.sample - block.start]! };
      }
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping || !this.#feeder) return;
    this.#pumping = true;
    const gen = this.#gen;
    const feeder = this.#feeder;
    try {
      while (gen === this.#gen && this.#ready.length + this.#pending.size < MAX_AHEAD) {
        const next = await feeder.next();
        if (gen !== this.#gen) break;
        if (next.done) {
          this.#feeder = null;
          break;
        }
        const { step, proxy, index, data } = next.value;
        const decoder = this.#decoderFor(proxy, index);
        const timestamp = ++this.#seq;
        this.#pending.set(timestamp, { from: step.from, to: step.to, gen });
        this.#fedUntil = Math.max(this.#fedUntil, step.to);
        decoder.decode(new EncodedVideoChunk({ type: step.key ? "key" : "delta", timestamp, data }));
      }
    } catch (error) {
      if (gen === this.#gen) this.#error(`Preview decode failed: ${(error as Error).message}`);
    } finally {
      this.#pumping = false;
    }
    if (gen !== this.#gen) void this.#pump();
  }

  #decoderFor(proxy: string, index: ProxyIndex): VideoDecoder {
    if (!this.#decoder || this.#decoder.state === "closed") {
      this.#decoder = new VideoDecoder({ output: (frame) => this.#onFrame(frame), error: (error) => this.#onDecoderError(error) });
      this.#configured = null;
    }
    if (this.#configured !== proxy) {
      // `prefer-hardware` means hardware only in Chromium; `no-preference` falls back to software (CI, VMs).
      this.#decoder.configure({ ...index.config, hardwareAcceleration: "no-preference", optimizeForLatency: true });
      this.#configured = proxy;
    }
    return this.#decoder;
  }

  #onFrame(frame: VideoFrame): void {
    this.stats.decoded++;
    const pending = this.#pending.get(frame.timestamp);
    this.#pending.delete(frame.timestamp);
    if (!pending || pending.gen !== this.#gen || pending.from === pending.to) {
      this.stats.discarded++;
      frame.close();
    } else {
      this.#ready.push({ from: pending.from, to: pending.to, frame });
    }
    void this.#pump();
    this.#queueTick();
  }

  #onDecoderError(error: Error): void {
    this.#error(`Preview decoder: ${error.message}`);
    this.#decoder = null;
    this.#configured = null;
    // Start over from what is due: a closed decoder decodes nothing more.
    this.#restart(this.#anchor ? this.#wantFrame() : this.#pausedFrame, false);
  }

  #close(ready: Ready): void {
    ready.frame.close();
  }

  // ---------- drawing ----------

  #queueTick(): void {
    if (this.#tickQueued) return;
    this.#tickQueued = true;
    scope.requestAnimationFrame(() => this.#tick());
  }

  #tick(): void {
    this.#tickQueued = false;
    const program = this.#program;
    if (!program) return;
    const playing = this.#anchor !== null && this.#clock !== null;
    if (program.frames > 0) this.#show(this.#wantFrame(), playing);
    else this.#drawBlack();
    if (playing) this.#scheduleAudio();
    void this.#pump();
    if (playing || this.#drawn === "") this.#queueTick();
  }

  #show(want: number, playing: boolean): void {
    while (this.#ready.length > 0 && this.#ready[0]!.to <= want) this.#close(this.#ready.shift()!);
    const span = programAt(this.#program!, want);
    if (!span || span.kind !== "media") {
      this.#drawBlack();
      return;
    }
    const head = this.#ready[0];
    if (head && head.from <= want) {
      const key = `f${head.from}`;
      if (this.#drawn !== key) {
        this.#draw(head.frame);
        this.#drawn = key;
        this.stats.drawn++;
      }
      this.#announce(want);
    } else if (playing && this.#drawn !== "") {
      this.stats.starved++;
    }
  }

  #drawBlack(): void {
    if (this.#drawn !== "black") {
      this.#context.fillStyle = "#000";
      this.#context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
      this.#drawn = "black";
    }
    this.#announce(-1);
  }

  /** Fit the frame into the canvas, letterboxed like export. */
  #draw(frame: VideoFrame): void {
    const { width, height } = this.#canvas;
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const w = Math.round(frame.displayWidth * scale);
    const h = Math.round(frame.displayHeight * scale);
    if (w !== width || h !== height) {
      this.#context.fillStyle = "#000";
      this.#context.fillRect(0, 0, width, height);
    }
    this.#context.drawImage(frame, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
  }

  #announce(frame: number): void {
    if (frame === this.#shown) return;
    this.#shown = frame;
    scope.postMessage({ type: "shown", frame });
  }

  // ---------- audio ----------

  #toContext(sample: number): number {
    const anchor = this.#anchor!;
    return anchor.frame + (sample - anchor.sample);
  }

  #post(message: ToMixer, transfer: Transferable[] = []): void {
    this.#audio?.postMessage(message, transfer);
  }

  #stopAudio(): void {
    for (const job of this.#audioJobs) job.limit = -Infinity;
    if (this.#anchor) this.#post({ type: "stop" });
  }

  #scheduleAudio(): void {
    const program = this.#program;
    if (!program || !this.#audio || !this.#anchor || !this.#clock) return;
    const horizon = this.#nowSample() + AUDIO_HORIZON_S * program.sampleRate;
    const end = Math.round((program.frames / program.fps) * program.sampleRate);
    while (this.#audioUntil < horizon && this.#audioUntil < end) {
      const from = this.#audioUntil;
      const to = Math.min(end, from + AUDIO_CHUNK);
      for (const read of audioReads(program.audio, from, to, AUDIO_CHUNK)) void this.#feedAudio(read, this.#anchor, this.#audioFadeFloor);
      this.#audioUntil = to;
    }
  }

  async #feedAudio(read: AudioRead, anchor: Anchor, fadeFloor: number): Promise<void> {
    const job: AudioJob = { limit: Infinity };
    this.#audioJobs.add(job);
    try {
      const { first, count } = sourceWindow(read);
      const bytesPerFrame = 2 * read.span.channels;
      const bytes = await this.#fetch(read.span.sidecar, first * bytesPerFrame, (first + count) * bytesPerFrame);
      if (job.limit <= read.from || this.#anchor !== anchor) return;
      let data = renderRead(read, new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), first);
      const to = Math.min(read.to, job.limit);
      if (to < read.to) data = data.slice(0, to - read.from);
      const chunk = {
        at: this.#toContext(read.from),
        data,
        fadeFrom: this.#toContext(Math.max(read.span.start, fadeFloor)),
        fadeTo: this.#toContext(Math.min(read.span.end, job.limit)),
      };
      this.stats.audioChunks++;
      this.#post({ type: "chunk", chunk }, [data.buffer]);
    } catch (error) {
      this.#error(`Cannot read ${read.span.sidecar}: ${(error as Error).message}`);
    } finally {
      this.#audioJobs.delete(job);
    }
  }

  // ---------- media I/O ----------

  #index(proxy: string): Promise<ProxyIndex> {
    let index = this.#proxies.get(proxy);
    if (!index) {
      index = openProxy(this.#reader(proxy));
      index.catch(() => this.#proxies.delete(proxy));
      this.#proxies.set(proxy, index);
    }
    return index;
  }

  #reader(path: string): (start: number, end: number) => Promise<Uint8Array> {
    return (start, end) => this.#fetch(path, start, end);
  }

  /** Bytes `[start, end)` of a project-relative file; empty past its end. */
  async #fetch(path: string, start: number, end: number): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array(0);
    const url = this.#mediaUrl + path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (response.status === 416) return new Uint8Array(0);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  #error(message: string): void {
    scope.postMessage({ type: "error", message });
  }
}

let engine: Engine | null = null;
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") engine = new Engine(message.canvas, message.mediaUrl);
  else engine?.handle(message);
};
