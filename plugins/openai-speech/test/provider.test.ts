import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpeechContext, SpeechProgress, SpeechProvider } from "@frameshell/plugin-api";
import { MODEL_PRICES, createOpenAiSpeechProvider } from "../src/index.js";
import { toneWavBytes, tone, wavBytes } from "./wav.js";

// Seam under test: the `openai` speech provider against a stub HTTP server on 127.0.0.1. The real API is never
// called and no real key exists here: KEY is a distinctive fake that must appear nowhere but the stub's request.
const KEY = "sk-proj-FAKEKEY-do-not-leak-0123456789";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}
type Reply = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let seen: Seen[];
let replies: Reply[];
const dirs: string[] = [];

beforeEach(async () => {
  seen = [];
  replies = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      // The last reply repeats, so a test lists only the answers that differ.
      (replies.length > 1 ? replies.shift()! : (replies[0] ?? wav()))(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const wav = (bytes: Buffer = toneWavBytes()): Reply => (_req, res) => {
  res.writeHead(200, { "Content-Type": "audio/wav" });
  res.end(bytes);
};
const status = (code: number, body: unknown): Reply => (_req, res) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
/** Fails the way a careless proxy might: with the caller's own Authorization header in the body. */
const echoing = (code: number): Reply => (req, res) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `bad request from ${req.headers.authorization} (key ${KEY})` } }));
};

const provider = (env: Record<string, string | undefined> = { OPENAI_API_KEY: KEY }): SpeechProvider =>
  createOpenAiSpeechProvider({ baseUrl: base, env, retryDelayMs: 1 });

/** A context that records every progress report; `texts()` is everything the provider said outside its result. */
function context(signal: AbortSignal = new AbortController().signal) {
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-openai-speech-")));
  dirs.push(outDir);
  const progress: SpeechProgress[] = [];
  const ctx: SpeechContext = { outDir, signal, ensureBinary: async () => "", progress: (update) => progress.push(update) };
  return { ctx, outDir, progress };
}

/** Run a call that must fail; the message, plus every progress report, must be free of the key. */
async function failure(call: (ctx: SpeechContext) => Promise<unknown>, signal?: AbortSignal): Promise<string> {
  const { ctx, progress } = context(signal);
  const error = await call(ctx).then(() => Promise.reject(new Error("expected a failure")), (e: unknown) => e as Error);
  const everything = JSON.stringify([error.message, error.stack?.split("\n")[0], Object.entries(error), progress]);
  expect(everything).not.toContain(KEY);
  expect(everything).not.toMatch(/FAKEKEY/);
  expect(everything).not.toMatch(/Bearer\s+sk-/);
  return error.message;
}

const say = (p: SpeechProvider, text = "Hola a todos") => (ctx: SpeechContext) => p.synthesize(text, "alloy", {}, ctx);

describe("synthesize", () => {
  it("posts the line to /v1/audio/speech with the key in the header only, and writes the WAV into outDir", async () => {
    replies = [wav()];
    const { ctx, outDir, progress } = context();
    const result = await provider().synthesize("Hola a todos", "nova", { language: "es" }, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/audio/speech", body: { model: "gpt-4o-mini-tts", input: "Hola a todos", voice: "nova", response_format: "wav" } });
    expect(Object.keys(seen[0]!.body).sort()).toEqual(["input", "model", "response_format", "voice"]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(result.model).toBe("gpt-4o-mini-tts");
    expect(result.file.startsWith(outDir)).toBe(true);
    const bytes = readFileSync(result.file);
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.equals(toneWavBytes())).toBe(true);
    expect(progress).toEqual([
      { message: "Asking OpenAI", fraction: 0 },
      { message: "OpenAI answered", fraction: 1 },
    ]);
    expect(JSON.stringify(progress)).not.toContain(KEY);
  });

  it("reads the key, model and server again on every call", async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-first" };
    const live = createOpenAiSpeechProvider({ env, baseUrl: base });
    expect(live.version).toBe("gpt-4o-mini-tts.1");
    await say(live)(context().ctx);
    env.OPENAI_API_KEY = "sk-second";
    env.FRAMESHELL_OPENAI_SPEECH_MODEL = "tts-1-hd";
    expect(live.version).toBe("tts-1-hd.1");
    await say(live)(context().ctx);
    expect(seen.map((s) => [s.headers.authorization, s.body.model])).toEqual([
      ["Bearer sk-first", "gpt-4o-mini-tts"],
      ["Bearer sk-second", "tts-1-hd"],
    ]);
  });

  it("takes the server address from FRAMESHELL_OPENAI_SPEECH_BASE_URL when no option names one", async () => {
    const p = createOpenAiSpeechProvider({ env: { OPENAI_API_KEY: KEY, FRAMESHELL_OPENAI_SPEECH_BASE_URL: `${base}/` } });
    await say(p)(context().ctx);
    expect(seen[0]!.url).toBe("/v1/audio/speech");
    const bad = createOpenAiSpeechProvider({ env: { OPENAI_API_KEY: KEY, FRAMESHELL_OPENAI_SPEECH_BASE_URL: "ftp://x" } });
    expect(await failure(say(bad))).toMatch(/must start with http/);
  });

  it("fails without a key, naming the variable and nothing else, and sends nothing", async () => {
    for (const env of [{}, { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "   " }]) {
      expect(await failure(say(provider(env)))).toBe("OPENAI_API_KEY is not set");
    }
    expect(seen).toEqual([]);
  });

  it("explains a rejected key (401, 403) without echoing anything the server sent, and does not retry", async () => {
    for (const code of [401, 403]) {
      seen = [];
      replies = [echoing(code)];
      const message = await failure(say(provider()));
      expect(message).toBe(`OpenAI rejected the key from OPENAI_API_KEY (HTTP ${code}): check that it is valid and may use speech`);
      expect(seen).toHaveLength(1);
    }
  });

  it("retries a 429 once and succeeds on the second answer", async () => {
    replies = [status(429, { error: { message: "slow down" } }), wav()];
    const { ctx } = context();
    const result = await say(provider())(ctx);
    expect(seen).toHaveLength(2);
    expect(readFileSync(result.file).length).toBeGreaterThan(44);
  });

  it("says rate limit and quota when 429 comes twice", async () => {
    replies = [status(429, { error: { message: "You exceeded your current quota" } })];
    const message = await failure(say(provider()));
    expect(message).toMatch(/rate limit or quota/);
    expect(message).toContain("You exceeded your current quota");
    expect(seen).toHaveLength(2);
  });

  it("calls a 500 twice a retryable server error, after exactly one retry", async () => {
    replies = [status(500, "upstream exploded")];
    const message = await failure(say(provider()));
    expect(message).toMatch(/server error \(HTTP 500\).*try again.*upstream exploded/);
    expect(seen).toHaveLength(2);
  });

  it("does not retry other 4xx answers and shows the message OpenAI gave", async () => {
    replies = [status(400, { error: { message: "Invalid value: 'bogus' is not a voice" } })];
    const message = await failure(say(provider()));
    expect(message).toBe("OpenAI refused the request (HTTP 400): Invalid value: 'bogus' is not a voice");
    expect(seen).toHaveLength(1);
  });

  it("scrubs the key, bearer tokens and sk- keys out of error bodies, whatever the status", async () => {
    for (const code of [400, 404, 422, 429, 500, 503]) {
      seen = [];
      replies = [echoing(code)];
      const message = await failure(say(provider()));
      expect(message).toContain("[key]");
      expect(message).toContain(`HTTP ${code}`);
    }
    replies = [status(400, { error: { message: "Incorrect API key provided: sk-proj-****abcd. Bearer abc.def-ghi was used" } })];
    const message = await failure(say(provider()));
    expect(message).not.toMatch(/sk-proj|abc\.def/);
    expect(message).toContain("[key]");
  });

  it("keeps a long body short", async () => {
    replies = [status(400, "x".repeat(5000))];
    expect((await failure(say(provider()))).length).toBeLessThan(500);
  });

  it("scrubs the key out of a failure to connect", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const p = createOpenAiSpeechProvider({ baseUrl: `http://127.0.0.1:${port}`, env: { OPENAI_API_KEY: KEY } });
    expect(await failure(say(p))).toMatch(/^could not reach OpenAI/);
  });

  it("stops at once when the signal aborts mid-request, without retrying", async () => {
    replies = [() => {}];
    const abort = new AbortController();
    const call = failure(say(provider()), abort.signal);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => seen.length > 0 && (clearInterval(poll), resolve()), 5);
    });
    abort.abort();
    expect(await call).toMatch(/abort/i);
    expect(seen).toHaveLength(1);
  });

  it("stops waiting for the retry when the signal aborts", async () => {
    replies = [status(500, "again")];
    const abort = new AbortController();
    const slow = createOpenAiSpeechProvider({ baseUrl: base, env: { OPENAI_API_KEY: KEY }, retryDelayMs: 60_000 });
    const call = failure(say(slow), abort.signal);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => seen.length > 0 && (clearInterval(poll), resolve()), 5);
    });
    abort.abort();
    await call;
    expect(seen).toHaveLength(1);
  });

  it("refuses a body that is not a WAV, or not mono 16-bit PCM, naming what it is", async () => {
    replies = [wav(Buffer.from("ID3 this is an mp3, honest"))];
    expect(await failure(say(provider()))).toMatch(/not a WAV file/);
    replies = [wav(wavBytes(tone(0.1, 24_000), { channels: 2 }))];
    expect(await failure(say(provider()))).toMatch(/not mono 16-bit PCM \(format 1, 2 channels, 16 bits\)/);
    replies = [wav(wavBytes(new Int16Array(100), { bits: 8 }))];
    expect(await failure(say(provider()))).toMatch(/8 bits/);
  });

  it("accepts any sample rate and repairs placeholder sizes of a streamed WAV", async () => {
    const samples = tone(0.1, 16_000);
    replies = [wav(wavBytes(samples, { sampleRate: 16_000, riffSize: 0xffffffff, dataSize: 0xffffffff }))];
    const { ctx } = context();
    const result = await say(provider())(ctx);
    const bytes = readFileSync(result.file);
    expect(bytes.readUInt32LE(24)).toBe(16_000);
    expect(bytes.readUInt32LE(40)).toBe(samples.length * 2);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.length).toBe(44 + samples.length * 2);
  });
});

describe("estimate", () => {
  it("is characters times the price of the model, in USD", () => {
    const e = provider().estimate!("Hola a todos", "alloy", {}) as { cost: number; currency: string; characters: number };
    expect(e).toEqual({ cost: 12 * MODEL_PRICES["gpt-4o-mini-tts"]!.usdPerCharacter, currency: "USD", characters: 12 });
    expect(e.cost).toBeGreaterThan(0);
  });

  it("counts code points, not bytes or UTF-16 units", () => {
    const p = provider();
    const per = MODEL_PRICES["gpt-4o-mini-tts"]!.usdPerCharacter;
    expect(p.estimate!("¿Cuántas pestañas tenés?", "alloy", {})).toEqual({ cost: 24 * per, currency: "USD", characters: 24 });
    expect(p.estimate!("ñandú 🎙️", "alloy", {})).toMatchObject({ characters: 8 });
  });

  it("uses the exact per-character price of tts-1 and tts-1-hd, read on every call", () => {
    const env: Record<string, string | undefined> = { FRAMESHELL_OPENAI_SPEECH_MODEL: "tts-1" };
    const p = createOpenAiSpeechProvider({ env });
    expect(p.estimate!("a".repeat(1000), "alloy", {})).toMatchObject({ cost: expect.closeTo(0.015, 9) });
    env.FRAMESHELL_OPENAI_SPEECH_MODEL = "tts-1-hd";
    expect(p.estimate!("a".repeat(1000), "alloy", {})).toMatchObject({ cost: expect.closeTo(0.03, 9) });
  });

  it("works with no key, and throws for a model with no known price instead of showing 0", () => {
    expect(() => provider({}).estimate!("hola", "alloy", {})).not.toThrow();
    expect(() => provider({ FRAMESHELL_OPENAI_SPEECH_MODEL: "gpt-9-speech" }).estimate!("hola", "alloy", {})).toThrow(/no price is known for the OpenAI model "gpt-9-speech"/);
  });

  it("has a price above zero for every model of the table", () => {
    for (const price of Object.values(MODEL_PRICES)) expect(price.usdPerCharacter).toBeGreaterThan(0);
  });
});

describe("voices and identity", () => {
  it("lists voices with no network and no key, alloy the default, all multilingual", async () => {
    const p = provider({});
    const voices = await p.voices();
    expect(voices.map((v) => v.id)).toEqual(expect.arrayContaining(["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]));
    expect(voices.every((v) => v.languages?.includes("es") && v.languages.includes("en"))).toBe(true);
    expect(p.id).toBe("openai");
    expect(p.defaultVoice).toBe("alloy");
    expect(p.free).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("puts the model into the version, so another model says the takes again", () => {
    expect(provider().version).toBe("gpt-4o-mini-tts.1");
    expect(provider({ FRAMESHELL_OPENAI_SPEECH_MODEL: "tts-1" }).version).toBe("tts-1.1");
  });
});
