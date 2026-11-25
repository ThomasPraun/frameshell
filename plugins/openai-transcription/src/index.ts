/**
 * `@frameshell/openai-transcription`: a paid cloud transcription provider (ADR 0046). Uses only the public plugin API;
 * the person's key comes from the `OPENAI_API_KEY` environment variable and nowhere else.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createOpenAiTranscriptionProvider } from "./provider.js";

export {
  BASE_URL_VARIABLE,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  KEY_VARIABLE,
  type OpenAiTranscriptionOptions,
  PROVIDER_ID,
  RETIREMENT_NOTE,
  type ServiceWord,
  TEXT_ONLY_MODELS,
  TIMING_NOTE,
  WORD_TIMED_MODEL,
  WORD_TIMED_MODEL_SHUTDOWN,
  createOpenAiTranscriptionProvider,
  scrub,
  timedWords,
} from "./provider.js";
export { MODEL_PRICES, type ModelPrice, PRICES_CHECKED, PRICE_SOURCE } from "./prices.js";
export { languageCode } from "./languages.js";
export { type Pcm, type PieceRange, pieceRanges, readPcm, wavOf } from "./pieces.js";

/** Plugin entry point: registers the `openai` transcription provider. */
export function activate(api: PluginApi): void {
  api.registerTranscriptionProvider(createOpenAiTranscriptionProvider());
}
