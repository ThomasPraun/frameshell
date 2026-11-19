/** What one minute of audio costs with one OpenAI transcription model. */
export interface ModelPrice {
  /** US dollars per minute of audio. */
  usdPerMinute: number;
}

/** Where {@link MODEL_PRICES} comes from: OpenAI's public pricing page (no account needed to read it). */
export const PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";

/** Day the table was checked against {@link PRICE_SOURCE}. Prices change: re-check before trusting an old figure. */
export const PRICES_CHECKED = "2026-11-18";

/**
 * Price per minute by model id, the only place a price lives, and the list of models this plugin uses: a model that
 * is not here has no known price, so `estimate()` and `transcribe()` refuse it before any audio is sent. Only
 * `whisper-1` gives word timestamps (ADR 0046 decision 6); the page lists it as "Whisper", $0.006 / minute.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "whisper-1": { usdPerMinute: 0.006 },
};
