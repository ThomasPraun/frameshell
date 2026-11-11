// Worker thread of `matteInWorker` (video.ts): one asset's matte, off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { standInMatte } from "./stand-in.js";
import { type MatteFiles, type MatteVideoRequest, loadSelfieMatte, matteVideo } from "./video.js";

await serveWorkerTask(async ({ runtime, model, ...request }: MatteFiles & MatteVideoRequest, onProgress) =>
  matteVideo(request, runtime !== null && model !== null ? await loadSelfieMatte(runtime, model) : standInMatte, onProgress),
);
