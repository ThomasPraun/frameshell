// Worker thread of `campplusWorkerEmbedder` (voice-embed.ts): one WAV's stretches, off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { type CampplusFiles, type Stretch, embedStretches } from "./voice-embed.js";

await serveWorkerTask(({ runtime, model, audio, stretches }: CampplusFiles & { audio: string; stretches: Stretch[] }, onProgress) =>
  embedStretches({ runtime, model }, audio, stretches, onProgress),
);
