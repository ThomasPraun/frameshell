/**
 * `@frameshell/openai-speech`: a paid speech provider for voiceovers (ADR 0034, decision 24). Uses only the public
 * plugin API; the person's key comes from the `OPENAI_API_KEY` environment variable and nowhere else.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createOpenAiSpeechProvider } from "./provider.js";

export {
  BASE_URL_VARIABLE,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  KEY_VARIABLE,
  MODEL_VARIABLE,
  type OpenAiSpeechOptions,
  PROVIDER_ID,
  createOpenAiSpeechProvider,
  scrub,
} from "./provider.js";
export { MODEL_PRICES, type ModelPrice, PRICES_CHECKED, PRICE_SOURCE } from "./prices.js";

/** Plugin entry point: registers the `openai` speech provider. */
export function activate(api: PluginApi): void {
  api.registerSpeechProvider(createOpenAiSpeechProvider());
}
