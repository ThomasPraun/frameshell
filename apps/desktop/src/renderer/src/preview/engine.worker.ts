// Preview engine (ADR 0001, SPEC §3.4): decodes proxies with WebCodecs and composites every video layer into an
// OffscreenCanvas on the audio clock, and feeds program audio from PCM sidecars to the one AudioWorklet mixer. Runs in
// a Worker: main-thread (React) stalls must not freeze the picture.
import { type Placement, type Size, layerRect } from "@frameshell/schema/composite";
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
import { type Program, type VideoSpan, firstAudioDifference, firstVideoDifference, programAt } from "./program.js";

/** DedicatedWorkerGlobalScope, as far as the engine uses it (the DOM lib types `self` as Window). */
interface WorkerScope {
  postMessage(message: FromEngine): void;
  onmessage: ((event: MessageEvent<ToEngine>) => void) | null;
  requestAnimationFrame(callback: (time: number) => void): number;
}
const scope = self as unknown as WorkerScope;

/** Decoded frames kept ahead of the playhead per layer (decoder queue included): ~0.4 s at 30 fps, as measured in ADR 0001. */
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

/** What a {@link LayerDecoder} needs from the engine. */
interface LayerHost {
  readonly program: Program | null;
  readonly stats: EngineStats;
  /** Program frame due now (playing) or shown (paused). */
  dueFrame(): number;
  index(proxy: string): Promise<ProxyIndex>;
  fetch(path: string, start: number, end: number): Promise<Uint8Array>;
  error(message: string): void;
  queueTick(): void;
}

/**
 * The decode pipeline of one video layer: its own `VideoDecoder`, fed the
 * layer's media spans from a program frame on, keeping up to
 * {@link MAX_AHEAD} decoded frames in program order.
 */
class LayerDecoder {
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
  /** Proxies that cannot be read: their spans are skipped, never waited for. */
  readonly failed = new Set<string>();

  constructor(
    private readonly host: LayerHost,
    readonly layer: number,
  ) {}

  /** Show `frame` next: keep what is decoded from it on, else decode from it. */
  moveTo(frame: number): void {
    const hit = this.#ready.findIndex((r) => r.from <= frame && frame < r.to);
    if (hit >= 0) {
      for (const stale of this.#ready.splice(0, hit)) stale.frame.close();
    } else {
      this.restart(frame, false);
    }
  }

  /** Restart decoding at `frame`, keeping decoded frames before `limit` when `keep`. */
  restart(frame: number, keep: boolean, limit = frame): void {
    this.#gen++;
    this.host.stats.restarts++;
    const kept: Ready[] = [];
    for (const ready of this.#ready) {
      if (keep && ready.from < limit) {
        ready.to = Math.min(ready.to, limit);
        kept.push(ready);
      } else ready.frame.close();
    }
    this.#ready = kept;
    this.#pending.clear();
    if (this.#decoder && this.#decoder.state === "configured") this.#decoder.reset();
    this.#configured = null;
    void this.#feeder?.return(undefined);
    this.#fedUntil = frame;
    const program = this.host.program;
    this.#feeder = program ? this.#steps(program.layers[this.layer] ?? [], frame, this.#gen) : null;
    void this.pump();
  }

  /**
   * The layer changed from frame `frame` on: keep what is decoded before
   * it, decode the rest again. Frames still in the decoder are lost on reset,
   * so decoding restarts at the first of those if it comes earlier.
   */
  restartKeeping(frame: number): void {
    let from = Math.min(frame, this.#fedUntil);
    for (const pending of this.#pending.values()) if (pending.gen === this.#gen) from = Math.min(from, pending.from);
    this.restart(from, true);
  }

  /** Close frames that end at or before `want`. */
  dropBefore(want: number): void {
    while (this.#ready.length > 0 && this.#ready[0]!.to <= want) this.#ready.shift()!.frame.close();
  }

  /** Decoded frame covering `want` (after {@link dropBefore}); null when not decoded yet. */
  frameAt(want: number): Ready | null {
    const head = this.#ready[0];
    return head && head.from <= want ? head : null;
  }

  async pump(): Promise<void> {
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
      if (gen === this.#gen) this.host.error(`Preview decode failed: ${(error as Error).message}`);
    } finally {
      this.#pumping = false;
    }
    if (gen !== this.#gen) void this.pump();
  }

  dispose(): void {
    this.#gen++;
    void this.#feeder?.return(undefined);
    this.#feeder = null;
    for (const ready of this.#ready) ready.frame.close();
    this.#ready = [];
    this.#pending.clear();
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    this.#decoder = null;
  }

  async *#steps(spans: readonly VideoSpan[], from: number, gen: number): AsyncGenerator<Step> {
    for (const span of spans) {
      if (span.end <= from || span.kind !== "media") continue;
      let index: ProxyIndex;
      try {
        index = await this.host.index(span.proxy);
      } catch (error) {
        this.failed.add(span.proxy);
        this.host.error(`Cannot read ${span.proxy}: ${(error as Error).message}`);
        this.host.queueTick();
        continue;
      }
      if (gen !== this.#gen) return;
      let block: { start: number; bytes: Uint8Array[] } | null = null;
      for (const step of decodeSteps(span, from, index.table)) {
        if (!block || step.sample < block.start || step.sample >= block.start + block.bytes.length) {
          const bytes = await readSamples(index, step.sample, step.sample + READ_SAMPLES, (start, end) => this.host.fetch(span.proxy, start, end));
          if (gen !== this.#gen) return;
          block = { start: step.sample, bytes };
        }
        yield { step, proxy: span.proxy, index, data: block.bytes[step.sample - block.start]! };
      }
    }
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
    this.host.stats.decoded++;
    const pending = this.#pending.get(frame.timestamp);
    this.#pending.delete(frame.timestamp);
    if (!pending || pending.gen !== this.#gen || pending.from === pending.to) {
      this.host.stats.discarded++;
      frame.close();
    } else {
      this.#ready.push({ from: pending.from, to: pending.to, frame });
    }
    void this.pump();
    this.host.queueTick();
  }

  #onDecoderError(error: Error): void {
    this.host.error(`Preview decoder: ${error.message}`);
    this.#decoder = null;
    this.#configured = null;
    // Start over from what is due: a closed decoder decodes nothing more.
    this.restart(this.host.dueFrame(), false);
  }
}

/** A still image as the engine holds it. */
type Still = { state: "loading" } | { state: "ready"; bitmap: ImageBitmap } | { state: "failed" };

/** One picture of a composite: what to draw and where. */
interface Part {
  image: CanvasImageSource;
  size: Size;
  placement: Placement;
}

class Engine implements LayerHost {
  readonly #canvas: OffscreenCanvas;
  readonly #context: OffscreenCanvasRenderingContext2D;
  readonly #mediaUrl: string;
  #audio: MessagePort | null = null;
  #program: Program | null = null;
  /** Bumped per program: a new program redraws even the same frames (placements may have moved). */
  #programVersion = 0;

  readonly #proxies = new Map<string, Promise<ProxyIndex>>();
  /** One decode pipeline per video layer, bottom first. */
  #layers: LayerDecoder[] = [];
  /** Still images by `path#version`. */
  readonly #stills = new Map<string, Still>();

  #anchor: Anchor | null = null;
  #clock: ClockSample | null = null;
  /** First program frame of the current play: shown until the clock reaches it. */
  #playFrom = 0;
  #pausedFrame = 0;
  /** What the canvas holds: a key of the composited pictures, `black`, or `` (must redraw). */
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

  get program(): Program | null {
    return this.#program;
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
          this.queueTick();
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

  dueFrame(): number {
    return this.#anchor ? this.#wantFrame() : this.#pausedFrame;
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
    this.queueTick();
  }

  // ---------- program ----------

  #setProgram(next: Program): void {
    const previous = this.#program;
    const current = previous ? this.dueFrame() : this.#pausedFrame;
    this.#program = next;
    this.#programVersion++;
    this.#drawn = "";
    for (const layer of next.layers) for (const span of layer) if (span.kind === "media") void this.index(span.proxy).catch(() => undefined);
    this.#forgetStills(next);

    while (this.#layers.length > next.layers.length) this.#layers.pop()!.dispose();
    for (const [i, pipeline] of this.#layers.entries()) {
      if (!previous) {
        pipeline.restart(this.#pausedFrame, false);
        continue;
      }
      const video = firstVideoDifference(previous, next, current, i);
      if (video === Infinity) continue;
      if (!this.#anchor && video <= this.#pausedFrame) pipeline.restart(this.#pausedFrame, false);
      else pipeline.restartKeeping(this.#anchor ? Math.max(video, current + 1) : video);
    }
    while (this.#layers.length < next.layers.length) {
      const pipeline = new LayerDecoder(this, this.#layers.length);
      this.#layers.push(pipeline);
      pipeline.restart(current, false);
    }

    if (previous && this.#anchor && this.#audio) {
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
    this.queueTick();
  }

  /** Show program frame `frame` while paused (or as the first frame of a play). */
  #moveTo(frame: number): void {
    this.#pausedFrame = frame;
    for (const layer of this.#layers) layer.moveTo(frame);
    this.queueTick();
  }

  // ---------- drawing ----------

  queueTick(): void {
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
    for (const layer of this.#layers) void layer.pump();
    if (playing || this.#drawn === "") this.queueTick();
  }

  /**
   * Composite frame `want` once every layer has its picture: while one is
   * still decoding the canvas keeps what it shows (a starved tick when
   * playing), so layers never show out of step.
   */
  #show(want: number, playing: boolean): void {
    const program = this.#program!;
    const parts: Part[] = [];
    let key = `v${this.#programVersion}`;
    let complete = true;
    for (const pipeline of this.#layers) {
      pipeline.dropBefore(want);
      const span = programAt(program, want, pipeline.layer);
      if (!span || span.kind === "placeholder") continue;
      if (span.kind === "still") {
        const still = this.#still(span.image, span.version);
        if (still.state === "loading") complete = false;
        else if (still.state === "ready") {
          parts.push({ image: still.bitmap, size: span.size, placement: span.placement });
          key += `|s${pipeline.layer}:${span.clip}`;
        }
        continue;
      }
      const ready = pipeline.frameAt(want);
      if (ready) {
        const { frame } = ready;
        parts.push({ image: frame, size: span.size ?? { width: frame.displayWidth, height: frame.displayHeight }, placement: span.placement });
        key += `|f${pipeline.layer}:${ready.from}`;
      } else if (!pipeline.failed.has(span.proxy)) {
        complete = false;
      }
    }
    if (!complete) {
      if (playing && this.#drawn !== "") this.stats.starved++;
      return;
    }
    if (parts.length === 0) {
      this.#drawBlack();
      return;
    }
    if (this.#drawn !== key) {
      this.#composite(parts);
      this.#drawn = key;
      this.stats.drawn++;
    }
    this.#announce(want);
  }

  #drawBlack(): void {
    if (this.#drawn !== "black") {
      this.#context.fillStyle = "#000";
      this.#context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
      this.#drawn = "black";
    }
    this.#announce(-1);
  }

  /** Black, then every part bottom first at its `layerRect` (export places layers the same way). */
  #composite(parts: readonly Part[]): void {
    const context = this.#context;
    const output = { width: this.#canvas.width, height: this.#canvas.height };
    const project = this.#program!.resolution;
    context.globalAlpha = 1;
    context.fillStyle = "#000";
    context.fillRect(0, 0, output.width, output.height);
    for (const part of parts) {
      const rect = layerRect(part.size, output, project, part.placement);
      context.globalAlpha = part.placement.opacity;
      context.drawImage(part.image, rect.left, rect.top, rect.width, rect.height);
    }
    context.globalAlpha = 1;
  }

  #announce(frame: number): void {
    if (frame === this.#shown) return;
    this.#shown = frame;
    scope.postMessage({ type: "shown", frame });
  }

  // ---------- stills ----------

  /** The image of a still span, loading it on first use (the tick that finds it loaded draws it). */
  #still(path: string, version: string): Still {
    const key = `${path}#${version}`;
    const known = this.#stills.get(key);
    if (known) return known;
    const loading: Still = { state: "loading" };
    this.#stills.set(key, loading);
    void (async () => {
      try {
        const response = await fetch(this.#url(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        if (this.#stills.get(key) !== loading) return bitmap.close();
        this.#stills.set(key, { state: "ready", bitmap });
      } catch (error) {
        if (this.#stills.get(key) !== loading) return;
        this.#stills.set(key, { state: "failed" });
        this.error(`Cannot read ${path}: ${(error as Error).message}`);
      }
      this.#drawn = "";
      this.queueTick();
    })();
    return loading;
  }

  /** Release images `program` no longer shows. */
  #forgetStills(program: Program): void {
    const used = new Set<string>();
    for (const layer of program.layers) for (const span of layer) if (span.kind === "still") used.add(`${span.image}#${span.version}`);
    for (const [key, still] of this.#stills) {
      if (used.has(key)) continue;
      if (still.state === "ready") still.bitmap.close();
      this.#stills.delete(key);
    }
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
      const bytes = await this.fetch(read.span.sidecar, first * bytesPerFrame, (first + count) * bytesPerFrame);
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
      this.error(`Cannot read ${read.span.sidecar}: ${(error as Error).message}`);
    } finally {
      this.#audioJobs.delete(job);
    }
  }

  // ---------- media I/O ----------

  index(proxy: string): Promise<ProxyIndex> {
    let index = this.#proxies.get(proxy);
    if (!index) {
      index = openProxy((start, end) => this.fetch(proxy, start, end));
      index.catch(() => this.#proxies.delete(proxy));
      this.#proxies.set(proxy, index);
    }
    return index;
  }

  #url(path: string): string {
    return this.#mediaUrl + path.split("/").map(encodeURIComponent).join("/");
  }

  /** Bytes `[start, end)` of a project-relative file; empty past its end. */
  async fetch(path: string, start: number, end: number): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array(0);
    const response = await fetch(this.#url(path), { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (response.status === 416) return new Uint8Array(0);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  error(message: string): void {
    scope.postMessage({ type: "error", message });
  }
}

let engine: Engine | null = null;
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") engine = new Engine(message.canvas, message.mediaUrl);
  else engine?.handle(message);
};
