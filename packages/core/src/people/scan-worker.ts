// Worker thread of `peopleScanWorker` (scan.ts): one video's scan, off the daemon's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { type PeopleScanFiles, type PeopleScanRequest, type PeopleScanWorkerMessage, loadScanModels, scanPeopleFaces } from "./scan.js";

const { runtime, detector, recognizer, ...request } = workerData as PeopleScanFiles & Omit<PeopleScanRequest, "onProgress" | "signal">;
const post = (message: PeopleScanWorkerMessage) => parentPort!.postMessage(message);
try {
  const models = await loadScanModels({ runtime, detector, recognizer });
  const result = await scanPeopleFaces({ ...request, ...models, onProgress: (fraction) => post({ type: "progress", fraction }) });
  post({ type: "done", result });
} catch (error) {
  post({ type: "error", message: (error as Error).message });
}
