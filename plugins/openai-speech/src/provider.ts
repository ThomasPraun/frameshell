import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { SpeechEstimate, SpeechProvider, SpeechVoice } from "@frameshell/plugin-api";
import { MODEL_PRICES } from "./prices.js";
import { checkWav } from "./wav.js";

/** Id of the provider: `--provider openai`, `provider: openai` in a voiceover script. */
export const PROVIDER_ID = "openai";
/** Environment variable that holds the person's API key. The only place the key is ever read from. */
export const KEY_VARIABLE = "OPENAI_API_KEY";
/** Environment variable that picks another model than {@link DEFAULT_MODEL}; read on every call. */
export const MODEL_VARIABLE = "FRAMESHELL_OPENAI_SPEECH_MODEL";
/** Environment variable that points at another server speaking the same API (a proxy, a local stand-in). */
export const BASE_URL_VARIABLE = "FRAMESHELL_OPENAI_SPEECH_BASE_URL";
/** Model used when {@link MODEL_VARIABLE} is not set. */
export const DEFAULT_MODEL = "gpt-4o-mini-tts";
/** Real API address; the request goes to `<base>/v1/audio/speech`. */
export const DEFAULT_BASE_URL = "https://api.openai.com";
/** Voice used when neither the call nor the script names one. */
export const DEFAULT_VOICE = "alloy";
/** Part of every take's cache key together with the model: bump when the request changes the sound. */
const OUTPUT_VERSION = "1";
/** Most of an upstream error body kept in a message. */
const BODY_LIMIT = 300;
const DEFAULT_RETRY_DELAY_MS = 800;

/** OpenAI voices. The model speaks any language it is given, so every voice is listed as multilingual. */
const VOICES: readonly SpeechVoice[] = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
].map((id) => ({ id, label: `${id[0]!.toUpperCase()}${id.slice(1)} (multilingual)`, languages: ["es", "en"] }));

/** What {@link createOpenAiSpeechProvider} takes; every part defaults to the real thing, tests inject their own. */
export interface OpenAiSpeechOptions {
  /** HTTP client. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Where the key, model and base URL are read from, on every call. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Server address without the `/v1/audio/speech` path. Default: `FRAMESHELL_OPENAI_SPEECH_BASE_URL`, else the real API. */
  baseUrl?: string;
  /** Wait before the one retry of a 429 or 5xx answer, in ms. Default 800. */
  retryDelayMs?: number;
}

/**
 * The `openai` speech provider (ADR 0034): one line of text to a WAV through OpenAI's speech endpoint, paid with
 * the person's own key. The key comes from the `OPENAI_API_KEY` variable at each call and goes only into the
 * `Authorization` header; every text that leaves this provider (errors, progress) is scrubbed of it.
 */
export function createOpenAiSpeechProvider(options: OpenAiSpeechOptions = {}): SpeechProvider {
  const env = () => options.env ?? process.env;
  const http = () => options.fetch ?? globalThis.fetch;
  const model = () => env()[MODEL_VARIABLE]?.trim() || DEFAULT_MODEL;
  const endpoint = () => {
    const base = (options.baseUrl ?? env()[BASE_URL_VARIABLE]?.trim() ?? DEFAULT_BASE_URL).replace(/\/+$/, "") || DEFAULT_BASE_URL;
    if (!/^https?:\/\//i.test(base)) throw new Error(`${BASE_URL_VARIABLE} must start with http:// or https://`);
    return `${base}/v1/audio/speech`;
  };
  return {
    id: PROVIDER_ID,
    // A getter: the model can change between calls through the environment, and its takes must be said again.
    get version() {
      return `${model()}.${OUTPUT_VERSION}`;
    },
    defaultVoice: DEFAULT_VOICE,
    voices: () => VOICES,
    estimate(text): SpeechEstimate {
      const id = model();
      const price = MODEL_PRICES[id];
      if (!price) {
        throw new Error(`no price is known for the OpenAI model "${id}" (${MODEL_VARIABLE}): the cost cannot be estimated, so nothing is generated`);
      }
      const characters = [...text].length;
      return { cost: characters * price.usdPerCharacter, currency: "USD", characters };
    },
    async synthesize(text, voice, _options, context) {
      const key = env()[KEY_VARIABLE]?.trim();
      if (!key) throw new Error(`${KEY_VARIABLE} is not set`);
      const id = model();
      const url = endpoint();
      const body = JSON.stringify({ model: id, input: text, voice, response_format: "wav" });
      context.progress({ message: "Asking OpenAI", fraction: 0 });
      const response = await request(http(), url, body, key, context.signal, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      let wav: Buffer;
      try {
        wav = checkWav(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        // No `cause` on purpose, here and below: only scrubbed text may leave this provider.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`OpenAI answered, but ${scrub((error as Error).message, key)}`);
      }
      const file = join(context.outDir, "take.wav");
      await writeFile(file, wav);
      context.progress({ message: "OpenAI answered", fraction: 1 });
      return { file, model: id };
    },
  };
}

/** POST once, and once more after a pause when OpenAI says to wait (429) or fails (5xx). Throws a scrubbed error otherwise. */
async function request(send: typeof fetch, url: string, body: string, key: string, signal: AbortSignal, retryDelayMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`could not reach OpenAI: ${scrub(causeOf(error), key)}`);
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt > 0) throw await failure(response, key);
    await response.body?.cancel().catch(() => {});
    await pause(retryDelayMs, signal);
  }
}

/** The error for a refused request, in words that name what the person can do and never repeat the key. */
async function failure(response: Response, key: string): Promise<Error> {
  const { status } = response;
  if (status === 401 || status === 403) {
    await response.body?.cancel().catch(() => {});
    return new Error(`OpenAI rejected the key from ${KEY_VARIABLE} (HTTP ${status}): check that it is valid and may use speech`);
  }
  const detail = scrub(await upstreamMessage(response), key);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 429) return new Error(`OpenAI rate limit or quota reached (HTTP 429): wait and try again, or check the plan and credit of the account${suffix}`);
  if (status >= 500) return new Error(`OpenAI had a server error (HTTP ${status}); it is usually temporary, so try again${suffix}`);
  return new Error(`OpenAI refused the request (HTTP ${status})${suffix}`);
}

/** The message OpenAI gave for an error, or the start of the body; empty when there is none. */
async function upstreamMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return message.trim();
  } catch {
    // Not JSON: the raw start of the body says enough.
  }
  return text.trim();
}

/**
 * Take the key, any bearer token and any `sk-` style key out of `text`, then cut it short. Applied to every text
 * built from the network, although OpenAI does not echo keys: a proxy or a captive page might.
 */
export function scrub(text: string, key: string): string {
  let clean = text;
  if (key) clean = clean.split(key).join("[key]");
  clean = clean.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [key]").replace(/\bsk-[\w*.-]{3,}/g, "[key]");
  return clean.length > BODY_LIMIT ? `${clean.slice(0, BODY_LIMIT)}...` : clean;
}

/** Message of a failed `fetch`, with the code of the lower-level cause (`ECONNREFUSED`) when there is one. */
function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `${message} (${code})` : message;
}

/** Wait `ms`; rejects at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
