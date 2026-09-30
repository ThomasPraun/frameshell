// Page side of the preview (ADR 0001): owns the AudioContext (the clock), the program AudioWorklet and the engine
// worker that decodes and draws. Implements the transport's player.
import EngineWorker from "./engine.worker.ts?worker";
import probeWorkletUrl from "./probe-recorder.worklet.ts?worker&url";
import programWorkletUrl from "./program-audio.worklet.ts?worker&url";
import type { Anchor, ClockSample, EngineStats, FromEngine, ToEngine } from "./engine-protocol.js";
import { heardTime, programSample } from "./engine-protocol.js";
import { PROGRAM_SAMPLE_RATE, type Program } from "./program.js";
import type { TransportPlayer } from "./transport.js";

/** Program start is scheduled this far after play: the first audio chunk is read and the worklet fed by then. */
const START_LEAD_S = 0.12;
/** Clock readings go to the worker this often; it extrapolates in between. */
const CLOCK_MS = 100;
/** Give up on audio output after this and play on a silent clock (no device, autoplay refused). */
const RESUME_TIMEOUT_MS = 1500;

/** What the player tells the page. */
export interface PlayerEvents {
  /** Clock reached `time` (program seconds) while playing; every display frame. */
  onTime(time: number): void;
  /** Program frame on the canvas changed; -1 = black. */
  onShown?(frame: number): void;
  onError?(message: string): void;
  /** Audio output is unavailable: playback runs on a silent clock. */
  onSilent?(): void;
}

/** A source of {@link ClockSample}s plus where rendering is (for scheduling). */
interface Clock {
  sample(): ClockSample;
  /** Context time being rendered now (ahead of what is heard). */
  renderTime(): number;
}

/**
 * Plays a {@link Program} into a canvas it creates inside `host`. Paused, it
 * shows the frame at the playhead; playing, the engine worker draws the frame
 * due on the audio clock and feeds the program AudioWorklet.
 */
export class PreviewPlayer implements TransportPlayer {
  readonly canvas: HTMLCanvasElement;
  readonly #worker: Worker;
  readonly #events: PlayerEvents;
  #program: Program | null = null;
  #context: AudioContext | null = null;
  readonly #audioReady: Promise<void>;
  #anchor: Anchor | null = null;
  #clock: Clock | null = null;
  #from = 0;
  #pausedTime = 0;
  #playToken = 0;
  /** Play requested and not paused since (the clock may still be starting). */
  #playing = false;
  #raf = 0;
  #clockTimer: ReturnType<typeof setInterval> | undefined;
  #stats: EngineStats | null = null;
  #disposed = false;
  readonly #probe: Probe | null;

  constructor(host: HTMLElement, mediaUrl: string, events: PlayerEvents, options: { probe?: boolean } = {}) {
    this.#events = events;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "preview-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    host.prepend(this.canvas);
    const offscreen = this.canvas.transferControlToOffscreen();
    this.#worker = new EngineWorker();
    this.#worker.onmessage = (event: MessageEvent<FromEngine>) => this.#onEngine(event.data);
    this.#send({ type: "init", canvas: offscreen, mediaUrl }, [offscreen]);
    this.#probe = options.probe ? new Probe(this) : null;
    this.#audioReady = this.#setupAudio().catch((error: unknown) => {
      this.#context = null;
      this.#events.onError?.(`Preview audio unavailable: ${(error as Error).message}`);
    });
  }

  /** Engine counters (latest report, about once a second). */
  get stats(): EngineStats | null {
    return this.#stats;
  }

  /** Program sample now playing at context frame `frame`; null while paused. */
  get anchor(): Anchor | null {
    return this.#anchor;
  }

  /** The program's AudioContext; null until set up or when audio is unavailable. */
  get audioContext(): AudioContext | null {
    return this.#context;
  }

  /** Play `program` from now on; a running playback continues (the engine re-decodes only what changed). */
  setProgram(program: Program): void {
    this.#program = program;
    this.#send({ type: "program", program });
  }

  /** Canvas size in pixels (the program frame at proxy resolution). */
  setSize(width: number, height: number): void {
    this.#send({ type: "size", width, height });
  }

  play(from: number): void {
    const token = ++this.#playToken;
    this.#playing = true;
    this.#pausedTime = from;
    void (async () => {
      await this.#audioReady;
      const context = this.#context;
      let audible = false;
      if (context) {
        audible = context.state === "running" || (await resume(context));
      }
      if (token !== this.#playToken || this.#disposed || !this.#program) return;
      if (!audible) this.#events.onSilent?.();
      const clock = audible && context ? audioClock(context) : wallClock();
      const startFrame = Math.ceil(((clock.renderTime() + START_LEAD_S) * PROGRAM_SAMPLE_RATE) / 128) * 128;
      this.#clock = clock;
      this.#from = from;
      this.#anchor = { frame: startFrame, sample: Math.round(from * PROGRAM_SAMPLE_RATE) };
      this.#send({ type: "play", anchor: this.#anchor, clock: clock.sample() });
      this.#clockTimer = setInterval(() => this.#send({ type: "clock", sample: clock.sample() }), CLOCK_MS);
      const loop = () => {
        this.#raf = requestAnimationFrame(loop);
        this.#events.onTime(this.#now());
      };
      this.#raf = requestAnimationFrame(loop);
    })();
  }

  pause(): number {
    this.#playToken++;
    this.#playing = false;
    const time = this.#anchor ? this.#onFrame(this.#now()) : this.#pausedTime;
    this.#stopClock();
    this.#pausedTime = time;
    this.#send({ type: "pause", frame: this.#frameOf(time) });
    return time;
  }

  seek(time: number): void {
    if (this.#playing) {
      this.pause();
      this.play(time);
      return;
    }
    this.#pausedTime = time;
    this.#send({ type: "seek", frame: this.#frameOf(time) });
  }

  dispose(): void {
    this.#disposed = true;
    this.#playToken++;
    this.#stopClock();
    this.#worker.terminate();
    void this.#context?.close();
    this.canvas.remove();
    this.#probe?.dispose();
  }

  // ---------- internals ----------

  /** Program seconds heard now; never before where this play started. */
  #now(): number {
    const anchor = this.#anchor;
    const clock = this.#clock;
    if (!anchor || !clock) return this.#pausedTime;
    const sample = programSample(anchor, heardTime(clock.sample(), epoch()), PROGRAM_SAMPLE_RATE);
    return Math.max(this.#from, sample / PROGRAM_SAMPLE_RATE);
  }

  #onFrame(time: number): number {
    const fps = this.#program?.fps ?? 30;
    return Math.floor(time * fps + 1e-6) / fps;
  }

  #frameOf(time: number): number {
    return Math.floor(time * (this.#program?.fps ?? 30) + 1e-6);
  }

  #stopClock(): void {
    cancelAnimationFrame(this.#raf);
    clearInterval(this.#clockTimer);
    this.#anchor = null;
    this.#clock = null;
  }

  #send(message: ToEngine, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer);
  }

  #onEngine(message: FromEngine): void {
    if (message.type === "shown") this.#events.onShown?.(message.frame);
    else if (message.type === "stats") this.#stats = message.stats;
    else this.#events.onError?.(message.message);
  }

  async #setupAudio(): Promise<void> {
    const context = new AudioContext({ sampleRate: PROGRAM_SAMPLE_RATE, latencyHint: "interactive" });
    this.#context = context;
    await context.audioWorklet.addModule(programWorkletUrl);
    const node = new AudioWorkletNode(context, "frameshell-program", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const output = context.createGain();
    node.connect(output);
    if (this.#probe) await this.#probe.insert(context, output);
    else output.connect(context.destination);
    // The worker writes chunks straight to the worklet: audio I/O never waits on the page.
    const channel = new MessageChannel();
    node.port.postMessage({ feed: channel.port1 }, [channel.port1]);
    this.#send({ type: "audio", port: channel.port2 }, [channel.port2]);
  }
}

function epoch(): number {
  return performance.timeOrigin + performance.now();
}

async function resume(context: AudioContext): Promise<boolean> {
  const timeout = new Promise<void>((settle) => setTimeout(settle, RESUME_TIMEOUT_MS));
  await Promise.race([context.resume().catch(() => undefined), timeout]);
  return context.state === "running";
}

/** The AudioContext's output clock: context time heard at a performance time. */
function audioClock(context: AudioContext): Clock {
  return {
    sample: () => {
      const stamp = context.getOutputTimestamp();
      if (stamp.contextTime && stamp.performanceTime) return { contextTime: stamp.contextTime, epoch: performance.timeOrigin + stamp.performanceTime };
      // Before the first output callback: estimate from the render position.
      return { contextTime: Math.max(0, context.currentTime - context.baseLatency - (context.outputLatency || 0)), epoch: epoch() };
    },
    renderTime: () => context.currentTime,
  };
}

/** Silent fallback: seconds since it was made, on the performance clock. */
function wallClock(): Clock {
  const start = epoch();
  return {
    sample: () => ({ contextTime: (epoch() - start) / 1000, epoch: epoch() }),
    renderTime: () => (epoch() - start) / 1000,
  };
}

/**
 * Measurement hooks for the ADR 0001 harness (`FRAMESHELL_PREVIEW_PROBE=1`):
 * records the program audio as heard by the graph and the audio clock's
 * output timestamps. Exposed as `window.frameshellPreviewProbe`.
 */
class Probe {
  #recorded: { start: number; data: Float32Array }[] = [];
  #timestamps: { contextTime: number; performanceTime: number }[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(player: PreviewPlayer) {
    (window as unknown as { frameshellPreviewProbe?: unknown }).frameshellPreviewProbe = {
      canvas: player.canvas,
      anchor: () => player.anchor,
      stats: () => player.stats,
      sampleRate: () => player.audioContext?.sampleRate ?? null,
      audioState: () => player.audioContext?.state ?? null,
      drainAudio: () => this.#drainAudio(),
      drainTimestamps: () => this.#timestamps.splice(0),
    };
  }

  async insert(context: AudioContext, output: AudioNode): Promise<void> {
    await context.audioWorklet.addModule(probeWorkletUrl);
    const recorder = new AudioWorkletNode(context, "frameshell-probe-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    recorder.port.onmessage = (event: MessageEvent<{ start: number; data: Float32Array }>) => this.#recorded.push(event.data);
    output.connect(recorder).connect(context.destination);
    this.#timer = setInterval(() => {
      const stamp = context.getOutputTimestamp();
      if (stamp.contextTime) this.#timestamps.push({ contextTime: stamp.contextTime, performanceTime: stamp.performanceTime ?? 0 });
    }, 250);
  }

  /** Recorded blocks since the last drain, samples as base64 little-endian f32. */
  #drainAudio(): { start: number; data: string }[] {
    return this.#recorded.splice(0).map(({ start, data }) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { start, data: btoa(binary) };
    });
  }

  dispose(): void {
    clearInterval(this.#timer);
    delete (window as unknown as { frameshellPreviewProbe?: unknown }).frameshellPreviewProbe;
  }
}
