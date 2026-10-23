// One task in a worker thread (face detection, face scans, voice prints): progress, one result, then the
// thread ends. `runWorkerTask` is the daemon's side, `serveWorkerTask` the worker script's.
import { Worker, parentPort, workerData } from "node:worker_threads";

/** Messages a task worker posts. */
export type WorkerTaskMessage<T> = { type: "progress"; fraction: number } | { type: "done"; result: T } | { type: "error"; message: string };

/**
 * Run the worker script `script` with `data` and resolve with the result it posts. The thread is terminated
 * once it answers or `signal` aborts; `label` names it when it exits without a result.
 */
export function runWorkerTask<T>(
  script: URL,
  data: unknown,
  label: string,
  options: { signal?: AbortSignal | undefined; onProgress?: ((fraction: number) => void) | undefined },
): Promise<T> {
  const { signal, onProgress } = options;
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(script, { workerData: data });
    const abort = () => {
      void worker.terminate();
      reject(signal!.reason as Error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const settle = () => signal?.removeEventListener("abort", abort);
    worker.on("message", (message: WorkerTaskMessage<T>) => {
      if (message.type === "progress") return onProgress?.(message.fraction);
      settle();
      void worker.terminate();
      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.once("error", (error) => {
      settle();
      reject(error);
    });
    // A promise settles once: after a result this rejection is ignored.
    worker.once("exit", (code) => {
      settle();
      reject(new Error(`${label} worker exited (code ${code}) without a result`));
    });
  });
}

/** In a worker script: run `work` on the thread's `workerData` and post its progress and result (or error). */
export async function serveWorkerTask<D, T>(work: (data: D, progress: (fraction: number) => void) => Promise<T>): Promise<void> {
  const post = (message: WorkerTaskMessage<T>) => parentPort!.postMessage(message);
  try {
    post({ type: "done", result: await work(workerData as D, (fraction) => post({ type: "progress", fraction })) });
  } catch (error) {
    post({ type: "error", message: (error as Error).message });
  }
}
