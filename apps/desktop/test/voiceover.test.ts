import { ErrorCode, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { costAsk, formatCost, runVoiceover } from "../src/main/voiceover.js";
import { strings } from "../src/shared/i18n/index.js";

const result = { lines: [] } as unknown as VoiceoverGenerateResult;
const refusal = (data: Record<string, unknown>) => new RpcError(ErrorCode.ConfirmationRequired, "confirm the cost", data);

describe("costAsk", () => {
  it("reads the provider, the lines to say and the estimate of the daemon's refusal", () => {
    expect(costAsk(refusal({ provider: "cloud", lines: ["hook-1", "fix-1"], cost: { amount: 0.04, currency: "USD" } }))).toEqual({ provider: "cloud", lines: 2, cost: "0.04 USD" });
  });

  it("keeps an unknown cost unknown", () => {
    expect(costAsk(refusal({ provider: "mystery", lines: ["hook-1"], cost: null }))).toEqual({ provider: "mystery", lines: 1, cost: null });
  });

  it("is null for every other error", () => {
    expect(costAsk(new RpcError(ErrorCode.SpeechFailed, "failed", {}))).toBeNull();
    expect(costAsk(new Error("boom"))).toBeNull();
  });
});

describe("formatCost", () => {
  it("shows up to four decimals without trailing zeros", () => {
    expect(formatCost({ amount: 0.04, currency: "USD" })).toBe("0.04 USD");
    expect(formatCost({ amount: 1.5, currency: "EUR" })).toBe("1.5 EUR");
    expect(formatCost({ amount: 0.00004, currency: "USD" })).toBe("0 USD");
  });
});

describe("runVoiceover", () => {
  it("runs once, without asking, when the provider is free", async () => {
    const request = vi.fn(async () => result);
    const confirm = vi.fn(async () => true);
    expect(await runVoiceover(request, confirm)).toBe(result);
    expect(request.mock.calls).toEqual([[false]]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks about a paid run and sends yes only after the person confirms", async () => {
    const request = vi.fn(async (yes: boolean) => {
      if (!yes) throw refusal({ provider: "cloud", lines: ["hook-1"], cost: { amount: 0.01, currency: "USD" } });
      return result;
    });
    const confirm = vi.fn(async () => true);
    expect(await runVoiceover(request, confirm)).toBe(result);
    expect(confirm).toHaveBeenCalledWith({ provider: "cloud", lines: 1, cost: "0.01 USD" });
    expect(request.mock.calls).toEqual([[false], [true]]);
  });

  it("generates nothing when the person declines", async () => {
    const request = vi.fn(async (yes: boolean) => {
      if (!yes) throw refusal({ provider: "cloud", lines: ["hook-1"], cost: null });
      return result;
    });
    expect(await runVoiceover(request, async () => false)).toBeNull();
    expect(request.mock.calls).toEqual([[false]]);
  });

  it("lets other errors through without asking", async () => {
    const failure = new RpcError(ErrorCode.SpeechProviderNotFound, "no such provider", {});
    const confirm = vi.fn(async () => true);
    await expect(runVoiceover(async () => Promise.reject(failure), confirm)).rejects.toBe(failure);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("the dialog strings", () => {
  it("name the provider, the lines and the cost in both languages", () => {
    for (const [language, again] of [["en", "already there"], ["es", "ya estaba"]] as const) {
      const said = strings(language).app.dialogs;
      expect(said.voiceoverCostTitle("cloud", 3)).toContain("3");
      expect(said.voiceoverCostKnown("0.04 USD")).toContain("0.04 USD");
      expect(said.voiceoverDoneDetail(1, 1)).toContain(again);
    }
  });
});
