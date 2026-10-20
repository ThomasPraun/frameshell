import type { Progress } from "@frameshell/protocol";
import type { Dict } from "../shared/i18n/index.js";

type Said = Dict["app"]["setup"]["progress"];

/**
 * The status-bar line for one daemon `progress` report, in the UI language of
 * `said`. Reports without a known `stage` (older daemons, plugins, new codes)
 * keep the daemon's English `message`.
 */
export function describeProgress(update: Pick<Progress, "message" | "stage" | "values">, said: Said): string {
  const v = update.values ?? {};
  const str = (key: string) => String(v[key] ?? "");
  switch (update.stage) {
    case "hash":
      return said.hash(str("asset"));
    case "extract-audio":
      return said.extractAudio(str("source"));
    case "binary":
      return said.binary(str("name"));
    case "binary-download":
      return said.binaryDownload(str("name"), str("version"), str("size"));
    case "binary-fallback":
      return said.binaryFallback(str("name"), str("accelerator"));
    case "model":
      return said.model(str("model"));
    case "model-download":
      return said.modelDownload(str("model"), str("size"));
    case "model-load":
      return said.modelLoad;
    case "gpu-compile":
      return said.gpuCompile;
    case "gpu-compiled":
      return said.gpuCompiled(str("seconds"));
    case "gpu-retry":
      return said.gpuRetry(str("device"), str("reason"));
    case "transcribe":
      return said.transcribe(str("device"));
    case "retranscribe":
      return said.retranscribe(str("from"), str("to"));
    case "diarize":
      return said.diarize(str("asset"));
    default:
      return update.message;
  }
}
