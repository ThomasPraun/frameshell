import { ErrorCode, type MethodResult, RpcError } from "@frameshell/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Confirmed } from "../src/main/confirmation.js";
import { type TranscribeAsk, formatLength, runTranscribe, transcribeAsk, transcribePrice } from "../src/main/transcribe-ask.js";
import { offersTranscribe } from "../src/renderer/src/transcript/model-choice.js";
import { strings } from "../src/shared/i18n/index.js";

const result = { asset: "assets/a.mp4" } as unknown as MethodResult<"transcribe">;
const TOKEN = "3f2a9c";
const data = (extra: Record<string, unknown> = {}) => ({
  provider: "openai",
  model: "whisper-1",
  asset: "assets/a.mp4",
  seconds: 125.2,
  cost: { amount: 0.0126, currency: "USD" },
  remote: true,
  confirmation: TOKEN,
  ...extra,
});
const refusal = (extra?: Record<string, unknown>) => new RpcError(ErrorCode.ConfirmationRequired, "confirm the upload", data(extra));
const stale = (extra?: Record<string, unknown>) => new RpcError(ErrorCode.ConfirmationStale, "changed", data(extra));

describe("transcribeAsk", () => {
  it("reads the provider, the asset, its length, the estimate, where the audio goes and the token", () => {
    expect(transcribeAsk(refusal())).toEqual({
      provider: "openai",
      model: "whisper-1",
      asset: "assets/a.mp4",
      seconds: 125.2,
      cost: "0.0126 USD",
      costFree: false,
      remote: true,
      changed: false,
      confirmation: TOKEN,
    });
  });

  it("keeps an unknown cost unknown and a local provider not remote", () => {
    expect(transcribeAsk(refusal({ cost: null, remote: false, model: null }))).toMatchObject({ cost: null, remote: false, model: null });
  });

  it("marks an estimate of exactly 0 as free, and any other amount or no estimate as not", () => {
    expect(transcribeAsk(refusal({ cost: { amount: 0, currency: "USD" } }))).toMatchObject({ cost: "0 USD", costFree: true });
    expect(transcribeAsk(refusal({ cost: { amount: 0.00004, currency: "USD" } }))).toMatchObject({ cost: "< 0.0001 USD", costFree: false });
    expect(transcribeAsk(refusal({ cost: null, costUnknown: true }))).toMatchObject({ cost: null, costFree: false });
  });

  it("marks a provider that declares itself free without an estimate as free, and a daemon that sends no costUnknown as unknown", () => {
    expect(transcribeAsk(refusal({ cost: null, costUnknown: false }))).toMatchObject({ cost: null, costFree: true });
    expect(transcribeAsk(refusal({ cost: null }))).toMatchObject({ cost: null, costFree: false });
  });

  it("picks the price text: free before unknown, so a free provider without an estimate never reads as may charge", () => {
    const priceOf = (extra: Record<string, unknown>) => transcribePrice(transcribeAsk(refusal(extra)) as TranscribeAsk);
    expect(priceOf({ cost: null, costUnknown: false })).toBe("free");
    expect(priceOf({ cost: { amount: 0, currency: "USD" } })).toBe("free");
    expect(priceOf({ cost: null, costUnknown: true })).toBe("unknown");
    expect(priceOf({ cost: null })).toBe("unknown");
    expect(priceOf({})).toBe("known");
  });

  it("marks the ask that replaces a confirmed one", () => {
    expect(transcribeAsk(stale({ confirmation: "new" }))).toMatchObject({ changed: true, confirmation: "new" });
  });

  it("is null for every other error, and for a refusal without a token", () => {
    expect(transcribeAsk(new RpcError(ErrorCode.TranscriptionFailed, "failed", {}))).toBeNull();
    expect(transcribeAsk(new Error("boom"))).toBeNull();
    expect(transcribeAsk(refusal({ confirmation: undefined }))).toBeNull();
  });
});

describe("runTranscribe", () => {
  it("runs once, without asking, when the provider is local", async () => {
    const request = vi.fn(async (_confirmed: Confirmed | null) => result);
    const confirm = vi.fn(async () => true);
    expect(await runTranscribe(request, confirm)).toBe(result);
    expect(request.mock.calls).toEqual([[null]]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks once, then runs again with yes and the ask's token only after the person confirms", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw refusal();
      return result;
    });
    const confirm = vi.fn(async (_ask: TranscribeAsk) => true);
    expect(await runTranscribe(request, confirm)).toBe(result);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({ provider: "openai", cost: "0.0126 USD", remote: true, changed: false });
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }]]);
  });

  it("sends nothing when the person declines", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw refusal();
      return result;
    });
    expect(await runTranscribe(request, async () => false)).toBeNull();
    expect(request.mock.calls).toEqual([[null]]);
  });

  it("asks again, with changed set, when the file or the price changed after the person confirmed", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw refusal();
      if (confirmed.confirmation === TOKEN) throw stale({ cost: { amount: 0.02, currency: "USD" }, confirmation: "second" });
      return result;
    });
    const confirm = vi.fn(async (_ask: TranscribeAsk) => true);
    expect(await runTranscribe(request, confirm)).toBe(result);
    expect(confirm.mock.calls.map(([ask]) => [ask.cost, ask.changed])).toEqual([["0.0126 USD", false], ["0.0200 USD", true]]);
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }], [{ yes: true, confirmation: "second" }]]);
  });

  it("declining the second ask stops there", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      throw confirmed ? stale({ confirmation: "second" }) : refusal();
    });
    const answers = [true, false];
    expect(await runTranscribe(request, async () => answers.shift()!)).toBeNull();
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }]]);
  });

  it("lets other errors through without asking", async () => {
    const failure = new RpcError(ErrorCode.TranscriptionFailed, "engine failed", {});
    const confirm = vi.fn(async () => true);
    await expect(runTranscribe(async () => Promise.reject(failure), confirm)).rejects.toBe(failure);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("formatLength", () => {
  it("shows m:ss, and h:mm:ss from an hour, rounding up", () => {
    expect(formatLength(125.2)).toBe("2:06");
    expect(formatLength(59)).toBe("0:59");
    expect(formatLength(3725)).toBe("1:02:05");
  });
});

describe("offersTranscribe", () => {
  it("is false for whisper.cpp and before the provider is known, true for any other", () => {
    expect(offersTranscribe(null)).toBe(false);
    expect(offersTranscribe("whisper-cpp")).toBe(false);
    expect(offersTranscribe("openai")).toBe(true);
  });
});

describe("the dialog strings", () => {
  it("say the audio is uploaded and name the cost in both languages", () => {
    for (const [language, uploaded] of [["en", "uploaded"], ["es", "sube"]] as const) {
      const said = strings(language).app.dialogs;
      expect(said.transcribeAskUploads("openai")).toContain(uploaded);
      expect(said.transcribeAskUploads("openai")).toContain("openai");
      expect(said.transcribeAskCostKnown("0.0126 USD", "openai")).toContain("0.0126 USD");
      expect(said.transcribeAskTitle("openai", "assets/a.mp4", "2:06")).toContain("2:06");
      expect(said.transcribeAskChanged.length).toBeGreaterThan(10);
      expect(said.transcribeAskCostFree).not.toContain("0 ");
    }
  });
});
