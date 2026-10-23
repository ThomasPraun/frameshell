import { Worker } from "node:worker_threads";
import type { DecoderOutput, PhotoPoint, PixelSize, SegmentEngine } from "./segmenter.js";

/** Files the segmentation worker loads: ONNX Runtime Web's module and MobileSAM's two models. */
export interface SegmentFiles {
  runtime: string;
  encoder: string;
  decoder: string;
}

/** Messages to `segment-worker.js`. `id` pairs a reply with its request. */
export type EngineRequest =
  | { id: number; op: "encode"; rgb: Uint8Array; size: PixelSize }
  | { id: number; op: "decode"; embedding: Float32Array; point: PhotoPoint; size: PixelSize };

/** Messages from `segment-worker.js`. */
export type EngineReply =
  | { id: number; op: "encode"; embedding: Float32Array }
  | { id: number; op: "decode"; answer: DecoderOutput }
  | { id: number; op: "error"; message: string };

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const SEGMENT_WORKER = import.meta.url.endsWith(".ts")
  ? new URL("../../dist/segment/segment-worker.js", import.meta.url)
  : new URL("./segment-worker.js", import.meta.url);

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A {@link SegmentEngine} that must be closed. */
export interface WorkerSegmentEngine extends SegmentEngine {
  /** Stop the worker; the next request starts a new one. */
  close(): Promise<void>;
}

/**
 * {@link SegmentEngine} in one long-lived worker thread, started by the first
 * request, so inference never blocks the daemon's event loop and the loaded
 * models are not paid for again per click. A worker that dies fails what it
 * had pending and is replaced by the next request.
 */
export function workerSegmentEngine(files: SegmentFiles, workerUrl: URL = SEGMENT_WORKER): WorkerSegmentEngine {
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, { resolve(reply: EngineReply): void; reject(error: Error): void }>();

  const start = (): Worker => {
    const started = new Worker(workerUrl, { workerData: files });
    // Idle models in memory must not keep the daemon's process alive.
    started.unref();
    const fail = (error: Error) => {
      if (worker === started) worker = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    started.on("message", (reply: EngineReply) => {
      const request = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.op === "error") request?.reject(new Error(reply.message));
      else request?.resolve(reply);
    });
    started.once("error", fail);
    started.once("exit", (code) => fail(new Error(`segmentation worker exited (code ${code}) without a result`)));
    return started;
  };

  const call = (request: DistributiveOmit<EngineRequest, "id">) =>
    new Promise<EngineReply>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      (worker ??= start()).postMessage({ ...request, id });
    });

  return {
    async encode(rgb, size) {
      const reply = await call({ op: "encode", rgb, size });
      if (reply.op !== "encode") throw new Error("segmentation worker answered an encode with a decode");
      return reply.embedding;
    },
    async decode(embedding, point, size) {
      const reply = await call({ op: "decode", embedding, point, size });
      if (reply.op !== "decode") throw new Error("segmentation worker answered a decode with an encode");
      return reply.answer;
    },
    async close() {
      const closing = worker;
      worker = undefined;
      for (const request of pending.values()) request.reject(new Error("segmentation worker closed"));
      pending.clear();
      await closing?.terminate();
    },
  };
}
