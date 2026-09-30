// AudioWorklet for the preview probe only (ADR 0001 harness): passes audio through and reports what it heard.
import { QuantumClock } from "./mixer.js";

declare const currentFrame: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Quanta per report: 64 x 128 frames, about 171 ms at 48 kHz. */
const BLOCK = 128 * 64;

/**
 * Reports blocks `{ start, data }`: `data[i]` was heard at context frame
 * `start + i`. Frames come from the same {@link QuantumClock} as the program
 * mixer's; a quantum the context rendered without calling `process()` ends
 * the block early, so the harness sees the hole as a recorder gap.
 */
class ProbeRecorder extends AudioWorkletProcessor {
  #buffer = new Float32Array(BLOCK);
  #filled = 0;
  #start = 0;
  readonly #clock = new QuantumClock();

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0] ?? [];
    for (const channel of output) {
      if (input) channel.set(input);
      else channel.fill(0);
    }
    const frame = this.#clock.tick(currentFrame);
    if (this.#filled > 0 && frame !== this.#start + this.#filled) this.#flush();
    if (this.#filled === 0) this.#start = frame;
    if (input) this.#buffer.set(input, this.#filled);
    else this.#buffer.fill(0, this.#filled, this.#filled + 128);
    this.#filled += 128;
    if (this.#filled === BLOCK) this.#flush();
    return true;
  }

  #flush(): void {
    const data = this.#filled === BLOCK ? this.#buffer : this.#buffer.slice(0, this.#filled);
    this.port.postMessage({ start: this.#start, data }, [data.buffer]);
    this.#buffer = new Float32Array(BLOCK);
    this.#filled = 0;
  }
}

registerProcessor("frameshell-probe-recorder", ProbeRecorder);
