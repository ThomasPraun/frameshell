import { readFile } from "node:fs/promises";
import type { TranscriptionEstimate, TranscriptionProvider, TranscriptionResult, TranscriptWord } from "@frameshell/plugin-api";
import { languageCode } from "./languages.js";
import { pieceRanges, readPcm, wavOf } from "./pieces.js";
import { MODEL_PRICES } from "./prices.js";

/** Id of the provider: `--provider openai`, `transcription.provider: "openai"`. */
export const PROVIDER_ID = "openai";
/** Environment variable that holds the person's API key. The only place the key is ever read from. */
export const KEY_VARIABLE = "OPENAI_API_KEY";
/** Environment variable that points at another server speaking the same API (a proxy, a local stand-in). */
export const BASE_URL_VARIABLE = "FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL";
/** The one model of this version: the only OpenAI transcription model with word timestamps (ADR 0046). */
export const DEFAULT_MODEL = "whisper-1";
/** Real API address; the request goes to `<base>/v1/audio/transcriptions`. */
export const DEFAULT_BASE_URL = "https://api.openai.com";
/** The note every result carries (ADR 0046 decision 7). */
export const TIMING_NOTE =
  "Word times come from OpenAI as the service gives them, coarser than whisper.cpp's alignment: check cuts by ear or with `transcribe --verify`.";
/**
 * Longest piece sent in one request. OpenAI takes at most 25 MB; 10 minutes of the host's 16 kHz mono 16-bit WAV is
 * 19.2 MB.
 */
const PIECE_SECONDS = 600;
/** How far before a piece's limit its cut may move to find a pause. */
const SEARCH_SECONDS = 20;
/** Characters of the text before a piece sent as its `prompt`: whisper-1 reads at most 224 tokens of it. */
const PROMPT_CHARACTERS = 200;
/** Most of an upstream error body kept in a message. */
const BODY_LIMIT = 300;
const DEFAULT_RETRY_DELAY_MS = 800;
/** The host gives transcription no abort signal, so each request ends on its own after this long. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** What {@link createOpenAiTranscriptionProvider} takes; every part defaults to the real thing, tests inject their own. */
export interface OpenAiTranscriptionOptions {
  /** HTTP client. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Where the key and base URL are read from, on every call. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Server address without the `/v1/audio/transcriptions` path. Default: `FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL`, else the real API. */
  baseUrl?: string;
  /** Wait before the one retry of a 429 or 5xx answer, in ms. Default 800. */
  retryDelayMs?: number;
  /** Longest wait for one request, in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Longest piece of audio sent in one request, in seconds. Default 600. */
  pieceSeconds?: number;
}

/** One word of OpenAI's `verbose_json` answer. */
export interface ServiceWord {
  word: string;
  start: number;
  end: number;
}

/**
 * The `openai` transcription provider (ADR 0046): the host's WAV to timed words through OpenAI's `whisper-1`, paid
 * with the person's own key. `remote` and `estimate` make the host ask the person before any audio is sent. The key
 * comes from `OPENAI_API_KEY` at each call and goes only into the `Authorization` header; every text that leaves
 * this provider (errors, progress) is scrubbed of it.
 */
export function createOpenAiTranscriptionProvider(options: OpenAiTranscriptionOptions = {}): TranscriptionProvider {
  const env = () => options.env ?? process.env;
  const http = () => options.fetch ?? globalThis.fetch;
  const endpoint = () => {
    const base = (options.baseUrl ?? env()[BASE_URL_VARIABLE]?.trim() ?? DEFAULT_BASE_URL).replace(/\/+$/, "") || DEFAULT_BASE_URL;
    if (!/^https?:\/\//i.test(base)) throw new Error(`${BASE_URL_VARIABLE} must start with http:// or https://`);
    return `${base}/v1/audio/transcriptions`;
  };
  return {
    id: PROVIDER_ID,
    remote: true,
    models: Object.keys(MODEL_PRICES).map((id) => ({ id })),
    defaultModel: DEFAULT_MODEL,
    estimate({ seconds }, { model = DEFAULT_MODEL }): TranscriptionEstimate {
      const minutes = seconds / 60;
      return { cost: minutes * priceOf(model).usdPerMinute, currency: "USD", minutes };
    },
    async transcribe(audio, { language, model = DEFAULT_MODEL, prompt }, context): Promise<TranscriptionResult> {
      priceOf(model);
      const key = env()[KEY_VARIABLE]?.trim();
      if (!key) throw new Error(`${KEY_VARIABLE} is not set`);
      const url = endpoint();
      const bytes = await readFile(audio);
      const pcm = readPcm(bytes);
      const ranges = pieceRanges(pcm, options.pieceSeconds ?? PIECE_SECONDS, SEARCH_SECONDS);
      const asked = language?.split(/[-_]/)[0]?.toLowerCase() || undefined;
      const words: TranscriptWord[] = [];
      let heardLanguage: string | undefined;
      let before = prompt ?? "";
      for (const [index, range] of ranges.entries()) {
        context.progress({
          message: ranges.length === 1 ? "Asking OpenAI" : `Asking OpenAI (part ${index + 1} of ${ranges.length})`,
          fraction: index / ranges.length,
          stage: "transcribe",
        });
        const wav = ranges.length === 1 ? bytes : wavOf(pcm.samples.subarray(range.from, range.to), pcm.sampleRate);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
        form.append("model", model);
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "word");
        if (asked) form.append("language", asked);
        const lead = before.trim().slice(-PROMPT_CHARACTERS);
        if (lead) form.append("prompt", lead);
        const response = await request(http(), url, form, key, model, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const answer = await readAnswer(response, key);
        const offset = range.from / pcm.sampleRate;
        words.push(...timedWords(answer.words, answer.text, offset));
        heardLanguage ??= languageCode(answer.language);
        before = answer.text;
      }
      context.progress({ message: "OpenAI answered", fraction: 1, stage: "transcribe" });
      const reported = asked ?? heardLanguage;
      return { model, words, notes: [TIMING_NOTE], ...(reported ? { language: reported } : {}) };
    },
  };
}

/** The price of `model`; throws for a model this plugin does not use, so nothing is sent for it. */
function priceOf(model: string) {
  const price = MODEL_PRICES[model];
  if (!price) {
    throw new Error(
      `the OpenAI provider transcribes only with ${Object.keys(MODEL_PRICES).join(", ")} (word timestamps, a known price), not "${model}": ` +
        `pass \`--model ${DEFAULT_MODEL}\``,
    );
  }
  return price;
}

/** The part of a `verbose_json` answer this provider reads; throws a scrubbed error when it lacks word timestamps. */
async function readAnswer(response: Response, key: string): Promise<{ text: string; language: unknown; words: ServiceWord[] }> {
  const body = await response.text();
  let parsed: { text?: unknown; language?: unknown; words?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error(`OpenAI answered with something that is not JSON: ${scrub(body.trim(), key)}`);
  }
  const words = Array.isArray(parsed.words) ? parsed.words : null;
  const valid = (word: unknown): word is ServiceWord => {
    const w = word as Partial<ServiceWord> | null;
    return typeof w?.word === "string" && Number.isFinite(w.start) && Number.isFinite(w.end);
  };
  if (words === null || !words.every(valid)) throw new Error("OpenAI answered without word timestamps");
  return { text: typeof parsed.text === "string" ? parsed.text : "", language: parsed.language, words };
}

/**
 * The service's words on the asset clock (`offset` added, 3 decimals), with case and punctuation taken from the
 * answer's `text`: `whisper-1` word entries carry neither. A word whose text token is not found within a few tokens
 * keeps the service's spelling.
 */
export function timedWords(words: readonly ServiceWord[], text: string, offset: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  let next = 0;
  const out: TranscriptWord[] = [];
  for (const word of words) {
    const bare = normalize(word.word);
    if (!bare) continue;
    let spelled = word.word.trim();
    for (let i = next; i < Math.min(tokens.length, next + 4); i++) {
      if (normalize(tokens[i]!) === bare) {
        spelled = tokens[i]!;
        next = i + 1;
        break;
      }
    }
    const start = round(offset + Math.max(0, word.start));
    out.push({ text: spelled, start, end: Math.max(start, round(offset + word.end)) });
  }
  return out;
}

/** A word reduced to its letters and digits, lowercase, for matching a word entry with its token in `text`. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** POST once, and once more after a pause when OpenAI says to wait (429) or fails (5xx). Throws a scrubbed error otherwise. */
async function request(send: typeof fetch, url: string, body: FormData, key: string, model: string, retryDelayMs: number, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // No `cause` on purpose, here and in the other errors: only scrubbed text may leave this provider.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`could not reach OpenAI: ${scrub(causeOf(error), key)}`);
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt > 0) throw await failure(response, key, model);
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

/**
 * The error for a refused request, in words that name what the person can do and never repeat the key. `model` is the
 * one the call asked for.
 */
async function failure(response: Response, key: string, model: string): Promise<Error> {
  const { status } = response;
  if (status === 401 || status === 403) {
    await response.body?.cancel().catch(() => {});
    return new Error(`OpenAI rejected the key from ${KEY_VARIABLE} (HTTP ${status}): check that it is valid and may use transcription`);
  }
  const upstream = await upstreamError(response);
  const detail = scrub(upstream.message, key);
  const suffix = detail ? `: ${detail}` : "";
  if ((status === 404 || status === 400) && (upstream.code === "model_not_found" || (status === 404 && RETIRED_MODEL.test(upstream.message)))) {
    return new Error(
      `OpenAI no longer serves the model "${scrub(model, key)}" (retired, removed, or not available to this key, HTTP ${status}); this provider only uses ${DEFAULT_MODEL}. Update @frameshell/openai-transcription or use \`--provider whisper-cpp\`${suffix}`,
    );
  }
  if (status === 404) return new Error(`OpenAI answered not found (HTTP 404): check ${BASE_URL_VARIABLE}${suffix}`);
  if (status === 413) return new Error(`OpenAI refused the audio as too large (HTTP 413)${suffix}`);
  if (status === 429) return new Error(`OpenAI rate limit or quota reached (HTTP 429): wait and try again, or check the plan and credit of the account${suffix}`);
  if (status >= 500) return new Error(`OpenAI had a server error (HTTP ${status}); it is usually temporary, so try again${suffix}`);
  return new Error(`OpenAI refused the request (HTTP ${status})${suffix}`);
}

/** What OpenAI's message says of a model that is gone, when the 404 carries no `model_not_found` code. */
const RETIRED_MODEL = /model\b.*\b(does not exist|not found|deprecated|retired|decommissioned|no longer)/i;

/** The message and code OpenAI gave for an error (the start of the body when it is not JSON); empty when there is none. */
async function upstreamError(response: Response): Promise<{ message: string; code: string | null }> {
  const text = await response.text().catch(() => "");
  try {
    const error = (JSON.parse(text) as { error?: { message?: unknown; code?: unknown } }).error;
    if (typeof error?.message === "string") return { message: error.message.trim(), code: typeof error.code === "string" ? error.code : null };
  } catch {
    // Not JSON: the raw start of the body says enough.
  }
  return { message: text.trim(), code: null };
}

/**
 * Take the key, any bearer token and any `sk-` style key out of `text`, then cut it short. Applied to every text
 * built from the network. Hand copy of `scrub` in `plugins/openai-speech/src/provider.ts` (plugins depend only on
 * the plugin API); `test/provider.test.ts` checks both give the same output.
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

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
