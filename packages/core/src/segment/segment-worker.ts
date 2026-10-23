// Worker thread of `workerSegmentEngine` (engine.ts): MobileSAM's two sessions, off the daemon's event loop.
import { parentPort, workerData } from "node:worker_threads";
import type { EngineReply, EngineRequest, SegmentFiles } from "./engine.js";
import { loadMobileSam } from "./segmenter.js";

const files = workerData as SegmentFiles;
const loaded = loadMobileSam(files.runtime, files.encoder, files.decoder);
loaded.catch(() => {}); // Reported to each request below, not as an unhandled rejection.

parentPort!.on("message", async (request: EngineRequest) => {
  // Copied, not transferred: an output may be a view into a larger buffer.
  const reply = (message: EngineReply) => parentPort!.postMessage(message);
  try {
    const engine = await loaded;
    if (request.op === "encode") {
      const embedding = await engine.encode(request.rgb, request.size);
      reply({ id: request.id, op: "encode", embedding });
    } else {
      const answer = await engine.decode(request.embedding, request.point, request.size);
      reply({ id: request.id, op: "decode", answer });
    }
  } catch (error) {
    reply({ id: request.id, op: "error", message: (error as Error).message });
  }
});
