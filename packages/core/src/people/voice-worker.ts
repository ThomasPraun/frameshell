// Worker thread of `campplusWorkerEmbedder` (voice-embed.ts): one WAV's stretches, off the daemon's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { type CampplusFiles, type Stretch, type VoiceWorkerMessage, embedStretches } from "./voice-embed.js";

const { runtime, model, audio, stretches } = workerData as CampplusFiles & { audio: string; stretches: Stretch[] };
const post = (message: VoiceWorkerMessage) => parentPort!.postMessage(message);
try {
  const embeddings = await embedStretches({ runtime, model }, audio, stretches, (fraction) => post({ type: "progress", fraction }));
  post({ type: "done", embeddings });
} catch (error) {
  post({ type: "error", message: (error as Error).message });
}
