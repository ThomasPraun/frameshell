// Worker thread of `peopleScanWorker` (scan.ts): one video's scan, off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { type PeopleScanFiles, type PeopleScanRequest, loadScanModels, scanPeopleFaces } from "./scan.js";

await serveWorkerTask(async ({ runtime, detector, recognizer, ...request }: PeopleScanFiles & Omit<PeopleScanRequest, "onProgress" | "signal">, onProgress) =>
  scanPeopleFaces({ ...request, ...(await loadScanModels({ runtime, detector, recognizer })), onProgress }),
);
