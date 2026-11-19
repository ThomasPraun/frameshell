import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscribeContext, TranscriptionProgress, TranscriptionProvider } from "@frameshell/plugin-api";
import { scrub as speechScrub } from "../../openai-speech/src/provider.js";
import { MODEL_PRICES, TIMING_NOTE, createOpenAiTranscriptionProvider, languageCode, pieceRanges, readPcm, scrub, timedWords, wavOf } from "../src/index.js";

// Seam under test: the `openai` transcription provider against a stub HTTP server on 127.0.0.1. The real API is
// never called and no real key exists here: KEY is a distinctive fake that must appear nowhere but the stub's request.
const KEY = "sk-proj-FAKEKEY-do-not-leak-0123456789";
const RATE = 16_000;

interface Seen {
  url: string | undefined;
  authorization: string | undefined;
  fields: Record<string, string>;
  /** Seconds of audio in the uploaded file. */
  seconds: number;
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
    req.on("end", async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const fields: Record<string, string> = {};
      let seconds = 0;
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") fields[name] = value;
        else seconds = readPcm(Buffer.from(await value.arrayBuffer())).samples.length / RATE;
      }
      seen.push({ url: req.url, authorization: req.headers.authorization, fields, seconds });
      // The last reply repeats, so a test lists only the answers that differ.
      (replies.length > 1 ? replies.shift()! : (replies[0] ?? answer()))(req, res);
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

const HEARD = { text: "Hola, mundo. ¿Qué tal?", language: "spanish", words: [{ word: "Hola", start: 0.2, end: 0.5 }, { word: "mundo", start: 0.6, end: 1.1 }, { word: "Qué", start: 1.4, end: 1.6 }, { word: "tal", start: 1.6, end: 1.9 }] };
const answer = (body: unknown = HEARD): Reply => (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

const provider = (env: Record<string, string | undefined> = { OPENAI_API_KEY: KEY }, extra: { pieceSeconds?: number } = {}): TranscriptionProvider =>
  createOpenAiTranscriptionProvider({ baseUrl: base, env, retryDelayMs: 1, ...extra });

/** A 16 kHz mono WAV of `seconds`: a tone everywhere except the `quiet` ranges (seconds). */
function audio(seconds: number, quiet: [number, number][] = []): string {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    if (!quiet.some(([from, to]) => t >= from && t < to)) samples[i] = Math.round(12_000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-openai-transcription-")));
  dirs.push(dir);
  const file = join(dir, "audio.wav");
  writeFileSync(file, wavOf(samples, RATE));
  return file;
}

function context() {
  const progress: TranscriptionProgress[] = [];
  const ctx: TranscribeContext = { ensureBinary: async () => "", ensureModel: async () => "", progress: (update) => progress.push(update) };
  return { ctx, progress };
}

/** Run a transcription that must fail; the message, plus every progress report, must be free of the key. */
async function failure(p: TranscriptionProvider, file = audio(1), model?: string): Promise<string> {
  const { ctx, progress } = context();
  const error = await p.transcribe(file, model ? { model } : {}, ctx).then(() => Promise.reject(new Error("expected a failure")), (e: unknown) => e as Error);
  const everything = JSON.stringify([error.message, error.stack?.split("\n")[0], Object.entries(error), progress]);
  expect(everything).not.toContain(KEY);
  expect(everything).not.toMatch(/FAKEKEY/);
  expect(everything).not.toMatch(/Bearer\s+sk-/);
  return error.message;
}

describe("the provider's declaration", () => {
  it("is remote, has an estimate and no `free`, and lists whisper-1 only", () => {
    const p = provider();
    expect(p.id).toBe("openai");
    expect(p.remote).toBe(true);
    expect(p.free).toBeUndefined();
    expect(p.models).toEqual([{ id: "whisper-1" }]);
    expect(p.defaultModel).toBe("whisper-1");
    expect(Object.keys(MODEL_PRICES)).toEqual(["whisper-1"]);
  });

  it("prices audio by the minute and refuses a model without a price", async () => {
    const p = provider();
    const priced = await p.estimate!({ seconds: 90 }, {});
    expect(priced).toMatchObject({ currency: "USD", minutes: 1.5 });
    expect(priced.cost).toBeCloseTo(0.009, 10);
    expect(() => p.estimate!({ seconds: 90 }, { model: "gpt-4o-transcribe" })).toThrow(/only with whisper-1.*--model whisper-1/);
  });
});

describe("transcribe", () => {
  it("uploads the WAV with whisper-1, verbose_json and word timestamps, the key in the header only", async () => {
    const { ctx, progress } = context();
    const result = await provider().transcribe(audio(2), { language: "es-AR" }, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "/v1/audio/transcriptions",
      authorization: `Bearer ${KEY}`,
      fields: { model: "whisper-1", response_format: "verbose_json", "timestamp_granularities[]": "word", language: "es" },
      seconds: 2,
    });
    expect(Object.keys(seen[0]!.fields).sort()).toEqual(["language", "model", "response_format", "timestamp_granularities[]"]);
    expect(result).toEqual({
      model: "whisper-1",
      language: "es",
      notes: [TIMING_NOTE],
      words: [
        { text: "Hola,", start: 0.2, end: 0.5 },
        { text: "mundo.", start: 0.6, end: 1.1 },
        { text: "¿Qué", start: 1.4, end: 1.6 },
        { text: "tal?", start: 1.6, end: 1.9 },
      ],
    });
    expect(JSON.stringify(progress)).not.toContain(KEY);
  });

  it("reports the language the service heard as a code, and passes a host prompt on", async () => {
    const { ctx } = context();
    const result = await provider().transcribe(audio(1), { prompt: "Antes dijo esto." }, ctx);
    expect(result.language).toBe("es");
    expect(seen[0]!.fields.prompt).toBe("Antes dijo esto.");
    expect(seen[0]!.fields.language).toBeUndefined();
  });

  it("cuts long audio at a pause into pieces, shifts their words back, and carries the text before as the prompt", async () => {
    replies = [answer({ text: "Uno.", words: [{ word: "Uno", start: 1, end: 1.5 }] }), answer({ text: "Dos.", words: [{ word: "Dos", start: 0.5, end: 0.9 }] })];
    const { ctx, progress } = context();
    const result = await provider(undefined, { pieceSeconds: 10 }).transcribe(audio(16, [[7.5, 8.5]]), {}, ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.seconds).toBeGreaterThan(7.5);
    expect(seen[0]!.seconds).toBeLessThan(8.5);
    expect(seen[0]!.seconds + seen[1]!.seconds).toBeCloseTo(16, 5);
    expect(seen[1]!.fields.prompt).toBe("Uno.");
    expect(result.words).toEqual([
      { text: "Uno.", start: 1, end: 1.5 },
      { text: "Dos.", start: Math.round((seen[0]!.seconds + 0.5) * 1000) / 1000, end: Math.round((seen[0]!.seconds + 0.9) * 1000) / 1000 },
    ]);
    expect(progress.map((p) => p.message)).toEqual(["Asking OpenAI (part 1 of 2)", "Asking OpenAI (part 2 of 2)", "OpenAI answered"]);
  });

  it("refuses another model and a missing key before sending anything", async () => {
    expect(await failure(provider(), audio(1), "gpt-4o-transcribe")).toMatch(/only with whisper-1/);
    for (const env of [{}, { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "   " }]) {
      expect(await failure(provider(env))).toBe("OPENAI_API_KEY is not set");
    }
    expect(seen).toEqual([]);
  });

  it("takes the server address from FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL and refuses one that is not http", async () => {
    const { ctx } = context();
    await createOpenAiTranscriptionProvider({ env: { OPENAI_API_KEY: KEY, FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL: `${base}/` } }).transcribe(audio(1), {}, ctx);
    expect(seen[0]!.url).toBe("/v1/audio/transcriptions");
    const bad = createOpenAiTranscriptionProvider({ env: { OPENAI_API_KEY: KEY, FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL: "ftp://x" } });
    expect(await failure(bad)).toMatch(/must start with http/);
  });

  it("fails on an answer without word timestamps", async () => {
    replies = [answer({ text: "Hola" })];
    expect(await failure(provider())).toBe("OpenAI answered without word timestamps");
    replies = [status(200, "<html>captive portal</html>")];
    expect(await failure(provider())).toMatch(/not JSON/);
  });

  it("explains a rejected key (401, 403) without echoing anything the server sent, and does not retry", async () => {
    for (const code of [401, 403]) {
      seen = [];
      replies = [echoing(code)];
      expect(await failure(provider())).toBe(`OpenAI rejected the key from OPENAI_API_KEY (HTTP ${code}): check that it is valid and may use transcription`);
      expect(seen).toHaveLength(1);
    }
  });

  it("retries a 429 or 5xx once, then explains it", async () => {
    replies = [status(429, { error: { message: "slow down" } }), answer()];
    const { ctx } = context();
    expect((await provider().transcribe(audio(1), {}, ctx)).words).toHaveLength(4);
    expect(seen).toHaveLength(2);
    seen = [];
    replies = [status(500, "upstream exploded")];
    expect(await failure(provider())).toMatch(/server error \(HTTP 500\).*try again.*upstream exploded/);
    expect(seen).toHaveLength(2);
  });

  it("scrubs the key, bearer tokens and sk- keys out of error bodies, whatever the status", async () => {
    for (const code of [400, 413, 429, 500]) {
      replies = [echoing(code)];
      const message = await failure(provider());
      expect(message).toContain("[key]");
      expect(message).toContain(`HTTP ${code}`);
    }
  });

  it("says a retired model is gone (404 or 400 with model_not_found), names the way out, and does not retry", async () => {
    for (const code of [404, 400]) {
      seen = [];
      replies = [status(code, { error: { message: `The model whisper-1 has been deprecated; key ${KEY} sk-live-abcdef`, type: "invalid_request_error", code: "model_not_found" } })];
      const message = await failure(provider());
      expect(message).toContain('no longer serves the model "whisper-1"');
      expect(message).toContain(`HTTP ${code}`);
      expect(message).toContain("Update @frameshell/openai-transcription or use `--provider whisper-cpp`");
      expect(message).toContain("[key]");
      expect(message).not.toMatch(/sk-live/);
      expect(seen).toHaveLength(1);
    }
  });

  it("recognises a retired model by the words of a 404 without the code, but not of another 400", async () => {
    replies = [status(404, { error: { message: "The model does not exist" } })];
    expect(await failure(provider())).toContain("no longer serves the model");
    replies = [status(400, { error: { message: "The model name is too long" } })];
    expect(await failure(provider())).toBe("OpenAI refused the request (HTTP 400): The model name is too long");
  });

  it("points a plain 404 at the server address, with no model claim, and does not retry", async () => {
    seen = [];
    replies = [status(404, { error: { message: "Invalid URL (POST /v1/audio/transcriptions)" } })];
    const message = await failure(provider());
    expect(message).toMatch(/^OpenAI answered not found \(HTTP 404\): check FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL/);
    expect(message).not.toContain("no longer serves");
    expect(seen).toHaveLength(1);
  });

  it("names a connection that failed, scrubbed", async () => {
    const closed = createOpenAiTranscriptionProvider({ baseUrl: "http://127.0.0.1:1", env: { OPENAI_API_KEY: KEY } });
    expect(await failure(closed)).toMatch(/^could not reach OpenAI/);
  });
});

describe("helpers", () => {
  it("scrub is the openai-speech one", () => {
    const samples = [`key ${KEY} here`, "Bearer abc.def-ghi and sk-proj-****abcd", "x".repeat(400), "", "nothing secret"];
    for (const text of samples) expect(scrub(text, KEY)).toBe(speechScrub(text, KEY));
  });

  it("keeps a word's own spelling when the text does not hold it, and never lets end precede start", () => {
    expect(timedWords([{ word: "hola", start: 1, end: 0.5 }, { word: " ", start: 2, end: 3 }, { word: "extra", start: 2, end: 2.5 }], "Hola.", 10)).toEqual([
      { text: "Hola.", start: 11, end: 11 },
      { text: "extra", start: 12, end: 12.5 },
    ]);
  });

  it("maps whisper language names and codes, nothing else", () => {
    expect([languageCode("spanish"), languageCode("EN"), languageCode("haitian creole"), languageCode("klingon"), languageCode("constructor"), languageCode(3)]).toEqual([
      "es",
      "en",
      "ht",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("cuts only what is longer than a piece, and every cut stays inside its search window", () => {
    const pcm = readPcm(wavOf(new Int16Array(RATE * 25).fill(1000), RATE));
    expect(pieceRanges(pcm, 30, 20)).toEqual([{ from: 0, to: RATE * 25 }]);
    const ranges = pieceRanges(pcm, 10, 20);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]!.from).toBe(0);
    expect(ranges.at(-1)!.to).toBe(RATE * 25);
    for (const [i, range] of ranges.entries()) {
      if (i > 0) expect(range.from).toBe(ranges[i - 1]!.to);
      expect(range.to - range.from).toBeLessThanOrEqual(RATE * 10);
    }
  });

  it("refuses a WAV that is not mono 16-bit PCM", () => {
    const stereo = wavOf(new Int16Array(4), RATE);
    stereo.writeUInt16LE(2, 22);
    expect(() => readPcm(stereo)).toThrow(/mono 16-bit/);
    expect(() => readPcm(Buffer.from("nope"))).toThrow(/not a WAV/);
  });
});
