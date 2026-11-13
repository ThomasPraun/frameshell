import { ErrorCode, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { type Confirmed, type CostAsk, costAsk, formatCost, runVoiceover } from "../src/main/voiceover.js";
import { strings } from "../src/shared/i18n/index.js";

const result = { lines: [] } as unknown as VoiceoverGenerateResult;
const refusal = (data: Record<string, unknown>) => new RpcError(ErrorCode.ConfirmationRequired, "confirm the cost", data);

const TOKEN = "3f2a9c";
const stale = (data: Record<string, unknown>) => new RpcError(ErrorCode.ConfirmationStale, "changed", data);

describe("costAsk", () => {
  it("reads the provider, the lines to say, the estimate and the token of the daemon's refusal", () => {
    expect(costAsk(refusal({ provider: "cloud", lines: ["hook-1", "fix-1"], cost: { amount: 0.04, currency: "USD" }, confirmation: TOKEN }))).toEqual({
      provider: "cloud",
      lines: 2,
      cost: "0.04 USD",
      changed: false,
      confirmation: TOKEN,
    });
  });

  it("keeps an unknown cost unknown", () => {
    expect(costAsk(refusal({ provider: "mystery", lines: ["hook-1"], cost: null, confirmation: TOKEN }))).toMatchObject({ provider: "mystery", lines: 1, cost: null });
  });

  it("marks the ask that replaces a confirmed one", () => {
    expect(costAsk(stale({ provider: "cloud", lines: ["hook-1"], cost: { amount: 0.02, currency: "USD" }, confirmation: "new" }))).toMatchObject({ changed: true, confirmation: "new" });
  });

  it("is null for every other error, and for a refusal without a token", () => {
    expect(costAsk(new RpcError(ErrorCode.SpeechFailed, "failed", {}))).toBeNull();
    expect(costAsk(new Error("boom"))).toBeNull();
    expect(costAsk(refusal({ provider: "cloud", lines: [], cost: null }))).toBeNull();
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
  const paid = (confirmation: string, cost = 0.01) => refusal({ provider: "cloud", lines: ["hook-1"], cost: { amount: cost, currency: "USD" }, confirmation });

  it("runs once, without asking, when the provider is free", async () => {
    const request = vi.fn(async (_confirmed: Confirmed | null) => result);
    const confirm = vi.fn(async () => true);
    expect(await runVoiceover(request, confirm)).toBe(result);
    expect(request.mock.calls).toEqual([[null]]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks about a paid run and sends yes with the ask's token only after the person confirms", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw paid(TOKEN);
      return result;
    });
    const confirm = vi.fn(async () => true);
    expect(await runVoiceover(request, confirm)).toBe(result);
    expect(confirm).toHaveBeenCalledWith({ provider: "cloud", lines: 1, cost: "0.01 USD", changed: false, confirmation: TOKEN });
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }]]);
  });

  it("asks again, with the new cost, when the run changed after the person confirmed", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw paid(TOKEN);
      if (confirmed.confirmation === TOKEN) throw stale({ provider: "cloud", lines: ["hook-1", "fix-1"], cost: { amount: 0.02, currency: "USD" }, confirmation: "second" });
      return result;
    });
    const confirm = vi.fn(async (_ask: CostAsk) => true);
    expect(await runVoiceover(request, confirm)).toBe(result);
    expect(confirm.mock.calls.map(([ask]) => [ask.cost, ask.changed])).toEqual([["0.01 USD", false], ["0.02 USD", true]]);
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }], [{ yes: true, confirmation: "second" }]]);
  });

  it("generates nothing when the person declines, also the second ask", async () => {
    const request = vi.fn(async (confirmed: Confirmed | null) => {
      if (!confirmed) throw paid(TOKEN);
      throw stale({ provider: "cloud", lines: ["hook-1"], cost: null, confirmation: "second" });
    });
    const answers = [true, false];
    expect(await runVoiceover(request, async () => answers.shift()!)).toBeNull();
    expect(request.mock.calls).toEqual([[null], [{ yes: true, confirmation: TOKEN }]]);
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
      expect(said.voiceoverCostChanged.length).toBeGreaterThan(10);
      expect(said.voiceoverDoneDetail(1, 1)).toContain(again);
    }
  });
});
