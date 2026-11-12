// Worker thread of BeatsStore: one asset's PCM to a beat grid, off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { type PcmAnalysis, analysePcm } from "./beats.js";

await serveWorkerTask(async (input: PcmAnalysis, onProgress) => analysePcm(input, onProgress));
