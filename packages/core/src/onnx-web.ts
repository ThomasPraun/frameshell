import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The part of ONNX Runtime Web's API used here; the module is downloaded, so it has no types at build time. */
export interface OrtModule {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: { create(model: Uint8Array, options?: { logSeverityLevel?: number }): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
}

/** A loaded model of {@link OrtModule}. */
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

/**
 * The model at `model` on the managed ONNX Runtime Web module at `runtime`
 * (its `.wasm` beside it), single-threaded in this thread.
 */
export async function loadOnnxModel(runtime: string, model: string): Promise<{ ort: OrtModule; session: OrtSession }> {
  const ort = (await import(/* @vite-ignore */ pathToFileURL(runtime).href)) as OrtModule;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(join(dirname(runtime), "/")).href;
  // Severity 3 = errors only: models from old converters (SFace) warn about every weight at load.
  const session = await ort.InferenceSession.create(new Uint8Array(await readFile(model)), { logSeverityLevel: 3 });
  return { ort, session };
}
