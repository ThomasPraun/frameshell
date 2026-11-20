/** What one minute of audio costs with one OpenAI transcription model. */
export interface ModelPrice {
  /** US dollars per minute of audio. */
  usdPerMinute: number;
  /** Where this one price comes from when it is not {@link PRICE_SOURCE}. */
  source?: string;
}

/** Where {@link MODEL_PRICES} comes from: OpenAI's public pricing page (no account needed to read it). */
export const PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";

/** Day the table was checked against {@link PRICE_SOURCE}. Prices change: re-check before trusting an old figure. */
export const PRICES_CHECKED = "2026-11-20";

/**
 * Price per minute by model id, the only place a price lives, and the list of models this plugin uses: a model that
 * is not here has no known price, so `estimate()` and `transcribe()` refuse it before any audio is sent (ADR 0046
 * decisions 6 and 11). `gpt-transcribe`, OpenAI's replacement for `whisper-1`, is not on the official page as of
 * {@link PRICES_CHECKED}: its $0.0045 / minute is the figure two independent guides give, so its `source` names one.
 * `whisper-1` is listed as "Whisper", $0.006 / minute; OpenAI retires it on 2027-02-26.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-transcribe": { usdPerMinute: 0.0045, source: "https://transcribe.so/blog/whisper-api-pricing-2026" },
  "whisper-1": { usdPerMinute: 0.006 },
};
