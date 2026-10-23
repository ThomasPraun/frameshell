// Worker thread of `yunetWorkerScanner` (faces.ts): one angle's scan, off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { type FaceScanRequest, type YunetFiles, angleFaceKeys, loadYunet } from "./faces.js";

await serveWorkerTask(async ({ runtime, model, ...request }: YunetFiles & Omit<FaceScanRequest, "onProgress" | "signal">, onProgress) =>
  angleFaceKeys({ ...request, detect: await loadYunet(runtime, model), onProgress }),
);
