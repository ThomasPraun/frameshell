/** What one character of text costs with one OpenAI speech model. */
export interface ModelPrice {
  /** US dollars per character of input text. */
  usdPerCharacter: number;
  /** True when the model is billed by tokens, so the per-character figure is an estimate, not the bill. */
  approximate: boolean;
}

/** Where {@link MODEL_PRICES} comes from: OpenAI's public pricing page (no account needed to read it). */
export const PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";

/** Day the table was checked against {@link PRICE_SOURCE}. Prices change: re-check before trusting an old figure. */
export const PRICES_CHECKED = "2026-11-18";

/**
 * Price per input character by model id, the only place a price lives. A model that is not here has no known
 * price, so `estimate()` throws instead of showing the cost as 0.
 *
 * - `tts-1` ($15) and `tts-1-hd` ($30) are billed per 1M characters: exact.
 * - `gpt-4o-mini-tts` is billed in tokens ($0.60 per 1M text input tokens, $12 per 1M audio output tokens), and the
 *   page does not say how many audio tokens a second of speech is. The figure assumes 1250 audio tokens a minute
 *   (about $0.015 a minute) and a voice that says 12 characters a second (a slow reading, so the estimate errs
 *   high), plus the text tokens at 3 characters each: 0.015 / 720 + 0.6e-6 / 3 = 0.0000210333, rounded up to 0.0000211. Approximate.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o-mini-tts": { usdPerCharacter: 0.0000211, approximate: true },
  "tts-1": { usdPerCharacter: 15 / 1_000_000, approximate: false },
  "tts-1-hd": { usdPerCharacter: 30 / 1_000_000, approximate: false },
};
