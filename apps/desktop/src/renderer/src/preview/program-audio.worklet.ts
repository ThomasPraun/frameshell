// AudioWorklet: plays program audio. The engine worker feeds chunks over a MessagePort handed in by the page.
import type { ToMixer } from "./engine-protocol.js";
import { ProgramMixer } from "./mixer.js";

// AudioWorkletGlobalScope, absent from the DOM lib.
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Registered name; the page creates `new AudioWorkletNode(context, PROGRAM_PROCESSOR)`. */
const PROGRAM_PROCESSOR = "frameshell-program";

class ProgramProcessor extends AudioWorkletProcessor {
  readonly #mixer = new ProgramMixer();

  constructor() {
    super();
    // The page sends one message: the port the engine worker writes to.
    this.port.onmessage = (event: MessageEvent<{ feed: MessagePort }>) => {
      event.data.feed.onmessage = (message: MessageEvent<ToMixer>) => this.#handle(message.data);
    };
  }

  #handle(message: ToMixer): void {
    if (message.type === "chunk") this.#mixer.schedule(message.chunk);
    else if (message.type === "cut") this.#mixer.cut(message.at);
    else this.#mixer.stop();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0] ?? [];
    const first = channels[0];
    if (!first) return true;
    this.#mixer.render(first, currentFrame);
    for (let c = 1; c < channels.length; c++) channels[c]!.set(first);
    return true;
  }
}

registerProcessor(PROGRAM_PROCESSOR, ProgramProcessor);
