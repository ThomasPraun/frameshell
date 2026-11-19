import { ErrorCode, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { type Confirmed, formatCost } from "../src/main/confirmation.js";
import { type CostAsk, canceledRun, costAsk, progressOf, runVoiceover, startOf, verifyPlanOf } from "../src/main/voiceover.js";
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
    for (const language of ["en", "es"] as const) {
      const said = strings(language).app.dialogs;
      expect(said.voiceoverCostTitle("cloud", 3)).toContain("3");
      expect(said.voiceoverCostKnown("0.04 USD")).toContain("0.04 USD");
      expect(said.voiceoverCostChanged.length).toBeGreaterThan(10);
    }
  });

  it("count what a run did and kept in both languages", () => {
    for (const [language, again, kept] of [["en", "already there", "kept"], ["es", "ya estaba", "conserva"]] as const) {
      const said = strings(language).voiceover;
      expect(said.summary(1, 1)).toContain(again);
      expect(said.stopped(0)).not.toContain(kept);
      expect(said.stopped(1)).toContain(kept);
      expect(said.placed(4, 2, "Voiceover")).toContain("4");
    }
  });
});

describe("progressOf", () => {
  it("names the line being said or checked and the step's fraction", () => {
    expect(progressOf({ message: "Saying hook-1 (1/2)", fraction: 0.5, stage: "speak", values: { line: "hook-1" } })).toEqual({ stage: "speak", line: "hook-1", fraction: 0.5 });
    expect(progressOf({ message: "Checking fix-1 (2/2)", stage: "verify", values: { line: "fix-1" } })).toEqual({ stage: "verify", line: "fix-1", fraction: null });
  });

  it("reports a download of the transcription tools as one", () => {
    expect(progressOf({ message: "Downloading whisper-cli", fraction: 0.2, stage: "binary-download" })).toEqual({ stage: "download", line: null, fraction: 0.2 });
    expect(progressOf({ message: "Downloading model", stage: "model-download" })).toMatchObject({ stage: "download" });
  });

  it("calls any other step of the provider a check", () => {
    expect(progressOf({ message: "Transcribing" })).toEqual({ stage: "verify", line: null, fraction: null });
  });
});

describe("canceledRun", () => {
  it("counts the takes a canceled run kept", () => {
    const stopped = new RpcError(ErrorCode.SpeechFailed, "Canceled", { canceled: true, written: ["a.wav", "b.wav"] });
    expect(canceledRun(stopped)).toEqual({ kept: 2 });
    expect(canceledRun(new RpcError(ErrorCode.SpeechFailed, "Canceled", { canceled: true }))).toEqual({ kept: 0 });
  });

  it("is null for a provider failure and for any other error", () => {
    expect(canceledRun(new RpcError(ErrorCode.SpeechFailed, "broke", { written: ["a.wav"] }))).toBeNull();
    expect(canceledRun(new RpcError(ErrorCode.InvalidParams, "bad", { canceled: true }))).toBeNull();
    expect(canceledRun(new Error("boom"))).toBeNull();
  });
});

describe("verifyPlanOf", () => {
  it("checks at once only when the transcription tools and model are already here", () => {
    expect(verifyPlanOf({ provider: "whisper-cpp", pluginInstalled: true, bytes: 0 })).toEqual({ kind: "ready" });
  });

  it("asks before any download, with its size", () => {
    expect(verifyPlanOf({ provider: "whisper-cpp", pluginInstalled: true, bytes: 574_000_000 })).toEqual({ kind: "download", bytes: 574_000_000 });
  });

  it("leaves the check out without the plugin, or with a provider the app cannot size", () => {
    expect(verifyPlanOf({ provider: "whisper-cpp", pluginInstalled: false, bytes: 0 })).toEqual({ kind: "unavailable" });
    expect(verifyPlanOf({ provider: "cloud-stt", pluginInstalled: true, bytes: 0 })).toEqual({ kind: "unavailable" });
  });
});

describe("startOf", () => {
  it("sends seconds as a number and leaves markers and grid references to the daemon", () => {
    expect(startOf(" 2.5 ")).toBe(2.5);
    expect(startOf("0")).toBe(0);
    expect(startOf("hook+0.5")).toBe("hook+0.5");
    expect(startOf("beat:9")).toBe("beat:9");
  });

  it("starts after the voice track's last clip when nothing is typed", () => {
    expect(startOf("")).toBeUndefined();
    expect(startOf("   ")).toBeUndefined();
  });
});
