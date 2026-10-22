// Worker thread of `yunetWorkerScanner` (faces.ts): one angle's scan, off the daemon's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { type FaceScanRequest, type FaceWorkerMessage, type YunetFiles, angleFaceKeys, loadYunet } from "./faces.js";

const { runtime, model, ...request } = workerData as YunetFiles & Omit<FaceScanRequest, "onProgress" | "signal">;
const post = (message: FaceWorkerMessage) => parentPort!.postMessage(message);
try {
  const detect = await loadYunet(runtime, model);
  const result = await angleFaceKeys({ ...request, detect, onProgress: (fraction) => post({ type: "progress", fraction }) });
  post({ type: "done", result });
} catch (error) {
  post({ type: "error", message: (error as Error).message });
}
