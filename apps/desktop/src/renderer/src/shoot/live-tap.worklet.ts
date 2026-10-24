// AudioWorklet of live recognition (ADR 0024 decision 5): the mic and system audio, mixed to mono by the node's
// input, as 16-bit samples in blocks of half a second at the context's rate (16 kHz).
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class LiveTap extends AudioWorkletProcessor {
  readonly #size = Math.round(sampleRate / 2);
  #block = new Int16Array(this.#size);
  #filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]!));
      this.#block[this.#filled++] = Math.round(sample * 32767);
      if (this.#filled === this.#size) {
        this.port.postMessage(this.#block, [this.#block.buffer]);
        this.#block = new Int16Array(this.#size);
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("frameshell-live-tap", LiveTap);
