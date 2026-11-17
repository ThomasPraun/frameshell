// Worker thread of `audio.inspect`: the spectrogram of one decoded WAV, off the daemon's event loop (a few hundred ms of FFTs).
import { readFile } from "node:fs/promises";
import { serveWorkerTask } from "../worker-task.js";
import { wavData } from "./energy-store.js";
import { type Spectrogram, spectrogram } from "./spectrogram.js";

await serveWorkerTask(async (wav: string): Promise<Spectrogram> => {
  const { rate, data } = wavData(await readFile(wav));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength - (data.byteLength % 2));
  const samples = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return spectrogram(samples, rate);
});
