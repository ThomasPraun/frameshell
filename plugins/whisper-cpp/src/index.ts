/**
 * `@frameshell/whisper-cpp`: the default transcription provider (SPEC §8.2,
 * ADR 0003). Uses only the public plugin API: the host supplies the pinned
 * whisper-cli binary and model files through the transcribe context.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createWhisperProvider } from "./provider.js";

export {
  DEFAULT_MODEL,
  MODELS,
  PROVIDER_ID,
  WHISPER_BINARY,
  type WhisperProviderOptions,
  createWhisperProvider,
} from "./provider.js";
export type { RunEngine } from "./engine.js";

/** Plugin entry point: registers the `whisper-cpp` provider. */
export function activate(api: PluginApi): void {
  api.registerTranscriptionProvider(createWhisperProvider());
}
