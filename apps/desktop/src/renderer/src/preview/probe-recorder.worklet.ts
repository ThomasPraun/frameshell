// AudioWorklet for the preview probe only (ADR 0001 harness): passes audio through and reports what it heard.

declare const currentFrame: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Quanta per report: 64 x 128 frames, about 171 ms at 48 kHz. */
const BLOCK = 128 * 64;

class ProbeRecorder extends AudioWorkletProcessor {
  #buffer = new Float32Array(BLOCK);
  #filled = 0;
  #start = 0;
  /** Own frame counter: the global `currentFrame` lags now and then (ADR 0001). */
  #position = -1;

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0] ?? [];
    for (const channel of output) {
      if (input) channel.set(input);
      else channel.fill(0);
    }
    if (this.#position < 0) this.#position = currentFrame;
    if (this.#filled === 0) this.#start = this.#position;
    this.#position += 128;
    if (input) this.#buffer.set(input, this.#filled);
    else this.#buffer.fill(0, this.#filled, this.#filled + 128);
    this.#filled += 128;
    if (this.#filled === BLOCK) {
      this.port.postMessage({ start: this.#start, data: this.#buffer }, [this.#buffer.buffer]);
      this.#buffer = new Float32Array(BLOCK);
      this.#filled = 0;
    }
    return true;
  }
}

registerProcessor("frameshell-probe-recorder", ProbeRecorder);
