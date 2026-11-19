import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptionProvider } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type AudioExtractor, isLocalFreeTranscription, requireLocalTranscription, transcribeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { toneWav } from "./whisper-fixture.js";

// ADR 0046: `transcribe` sends no audio to a paid, unknown-cost or remote provider before `yes`, and every other
// caller takes only a local free one.

function project(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), "{}");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "talk.mp4"), "talk");
  return dir;
}

/** Writes a 90 s 16 kHz WAV, as the real extraction would. */
const extract: AudioExtractor = async (_input, output) => writeFileSync(output, toneWav(90, [[1, 2]]));

/** A provider whose `transcribe` counts its calls; `shape` adds the cost and place fields under test. */
function counted(shape: Partial<TranscriptionProvider> & { id?: string }) {
  const calls: string[] = [];
  const provider: TranscriptionProvider = {
    id: "cloud",
    ...shape,
    async transcribe(audio) {
      calls.push(audio);
      return { model: "m", words: [{ text: "Hola", start: 0.5, end: 0.9 }] };
    },
  };
  return { provider, calls };
}

const run = (dir: string, provider: TranscriptionProvider, extra: { yes?: boolean; confirmation?: string; model?: string } = {}) =>
  transcribeAsset({
    projectDir: dir,
    asset: join(dir, "assets", "talk.mp4"),
    providerId: provider.id,
    provider,
    tools: { ensureBinary: async (name) => `/bin/${name}`, ensureModel: async (id) => `/models/${id}` },
    extractAudio: extract,
    ...extra,
  });

async function refusal(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

const paid = () =>
  counted({ remote: true, estimate: ({ seconds }) => ({ cost: (seconds / 60) * 0.006, currency: "USD", minutes: seconds / 60 }) });

describe("transcribe consent", () => {
  it("refuses a remote paid provider until `yes`, saying the audio is uploaded and what it costs, and sends nothing", async () => {
    const dir = project();
    const { provider, calls } = paid();
    const error = await refusal(run(dir, provider, { model: "whisper-1" }));
    expect(error.code).toBe(ErrorCode.ConfirmationRequired);
    expect(error.message).toMatch(/^Transcribing assets\/talk\.mp4 with cloud uploads its audio \(1:30 of audio\) to that service and costs about 0\.0090 USD, plus short re-checks/);
    expect(error.data).toEqual({
      provider: "cloud",
      model: "whisper-1",
      asset: "assets/talk.mp4",
      seconds: 90,
      cost: { amount: expect.closeTo(0.009, 10), currency: "USD" },
      remote: true,
      confirmation: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "transcripts"))).toBe(false);

    const token = (error.data as { confirmation: string }).confirmation;
    const result = await run(dir, provider, { model: "whisper-1", yes: true, confirmation: token });
    expect(result.words).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("asks again on every run: no consent is stored", async () => {
    const dir = project();
    const { provider } = paid();
    await run(dir, provider, { yes: true });
    expect((await refusal(run(dir, provider))).code).toBe(ErrorCode.ConfirmationRequired);
  });

  it("fails as stale, sending nothing, when the confirmed token is for another run", async () => {
    const dir = project();
    const { provider, calls } = paid();
    const error = await refusal(run(dir, provider, { yes: true, confirmation: "0".repeat(32) }));
    expect(error.code).toBe(ErrorCode.ConfirmationStale);
    expect(error.data).toMatchObject({ provider: "cloud", hint: expect.any(String), confirmation: expect.not.stringMatching(/^0+$/) });
    expect(calls).toEqual([]);
  });

  it("keeps the token when the cost moves by less than a cent between the ask and the confirmed call", async () => {
    const dir = project();
    const costs = [0.00904, 0.00896];
    const { provider, calls } = counted({ remote: true, estimate: () => ({ cost: costs.shift() ?? 0, currency: "USD" }) });
    const token = ((await refusal(run(dir, provider))).data as { confirmation: string }).confirmation;
    await run(dir, provider, { yes: true, confirmation: token });
    expect(calls).toHaveLength(1);
  });

  it("treats an estimate that is not a finite number as an unknown cost", async () => {
    const { provider, calls } = counted({ remote: true, estimate: () => ({ cost: Number.NaN, currency: "USD" }) });
    const error = await refusal(run(project(), provider));
    expect(error.code).toBe(ErrorCode.ConfirmationRequired);
    expect(error.message).toMatch(/to that service and may cost money: it gives no usable estimate/);
    expect(error.message).not.toContain("NaN");
    expect(error.data).toMatchObject({ cost: null });
    expect(calls).toEqual([]);
  });

  it("treats a provider without estimate or `free: true` as paid at an unknown cost", async () => {
    const dir = project();
    const { provider, calls } = counted({});
    const error = await refusal(run(dir, provider));
    expect(error.code).toBe(ErrorCode.ConfirmationRequired);
    expect(error.message).toMatch(/may send its audio \(1:30 of audio\) off this machine and may cost money/);
    expect(error.data).toMatchObject({ cost: null, remote: false });
    expect(calls).toEqual([]);
  });

  it("asks before a free remote provider, and not before a local one that is free or estimates 0", async () => {
    const remote = counted({ free: true, remote: true });
    expect((await refusal(run(project(), remote.provider))).message).toMatch(/uploads its audio \(1:30 of audio\) to that service\. Ask/);
    for (const shape of [{ free: true }, { estimate: () => ({ cost: 0, currency: "USD" }) }, { id: "whisper-cpp" }]) {
      const { provider, calls } = counted(shape);
      await run(project(), provider);
      expect(calls).toHaveLength(1);
    }
  });

  it("reports an estimate that throws as TranscriptionFailed before any audio is sent", async () => {
    const { provider, calls } = counted({
      remote: true,
      estimate: () => {
        throw new Error("no price for model x");
      },
    });
    const error = await refusal(run(project(), provider, { yes: true }));
    expect(error.code).toBe(ErrorCode.TranscriptionFailed);
    expect(error.message).toContain("no price for model x");
    expect(calls).toEqual([]);
  });
});

describe("local-only callers", () => {
  it("take only a provider that is local and free, whisper-cpp of any version included", () => {
    const local = [{ free: true }, { id: "whisper-cpp" }];
    const other = [{}, { free: true, remote: true }, { free: true, estimate: () => ({ cost: 0, currency: "USD" }) }, { id: "whisper-cpp", remote: true }];
    for (const shape of local) expect(isLocalFreeTranscription(counted(shape).provider)).toBe(true);
    for (const shape of other) expect(isLocalFreeTranscription(counted(shape).provider)).toBe(false);
  });

  it("refuse any other with TranscriptionFailed naming `transcribe --yes` and a local provider", () => {
    const { provider } = paid();
    expect(() => requireLocalTranscription(provider, "openai", "exports/cut.mp4")).toThrow(
      expect.objectContaining({ code: ErrorCode.TranscriptionFailed, data: expect.objectContaining({ provider: "openai", asset: "exports/cut.mp4" }) }),
    );
    expect(() => requireLocalTranscription(provider, "openai", null)).toThrow(/transcribe --yes.*--provider whisper-cpp/);
  });
});
