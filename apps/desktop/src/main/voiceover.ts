// The app's voiceover run (ADR 0034 decisions 12 and 20): the daemon refuses a paid generation with `ConfirmationRequired`
// and the cost it found; the app asks the person and sends `yes` with that ask's `confirmation` token only after they
// confirm, so a run whose lines or cost changed meanwhile (`ConfirmationStale`) asks again. No dialog code here, so it is testable.
// Also the pure parts of the rest of the app's voiceover: progress, Cancel, the misread check's plan, where placing starts.
import { ErrorCode, type Progress, RpcError, type VoiceoverGenerateResult, timeRefOf } from "@frameshell/protocol";
import type { VoiceoverProgress, VoiceoverVerifyPlan } from "../shared/api.js";
import { type Confirmed, formatCost, isAsk, runConfirmed } from "./confirmation.js";

export { type Confirmed, formatCost };

/** Transcription provider the app can set up and size a download for (`transcriptionDownload` in `main/index.ts`). */
export const APP_TRANSCRIPTION_PROVIDER = "whisper-cpp";

/**
 * How the misread check can run in a project (ADR 0034 decision 18): the daemon downloads the transcription tools and
 * model on first use, which the app never lets happen unasked. Only the app's own transcription plugin is sized
 * (`bytes` = what is still to download for it); any other provider, or a project without the plugin, is `unavailable`.
 */
export function verifyPlanOf(facts: { provider: string; pluginInstalled: boolean; bytes: number }): VoiceoverVerifyPlan {
  if (facts.provider !== APP_TRANSCRIPTION_PROVIDER || !facts.pluginInstalled) return { kind: "unavailable" };
  return facts.bytes > 0 ? { kind: "download", bytes: facts.bytes } : { kind: "ready" };
}

/** A daemon progress report of `voiceover.generate` as the dialog shows it. */
export function progressOf(update: Progress): VoiceoverProgress {
  const line = typeof update.values?.["line"] === "string" ? update.values["line"] : null;
  const fraction = update.fraction === undefined ? null : update.fraction;
  if (update.stage?.includes("download")) return { stage: "download", line: null, fraction };
  return { stage: update.stage === "speak" ? "speak" : "verify", line, fraction };
}

/** The takes kept by a generation that Cancel stopped (`voiceover.cancel`); null for any other error. */
export function canceledRun(error: unknown): { kept: number } | null {
  if (!(error instanceof RpcError) || error.code !== ErrorCode.SpeechFailed) return null;
  const data = error.data as { canceled?: boolean; written?: unknown } | undefined;
  return data?.canceled === true ? { kept: Array.isArray(data.written) ? data.written.length : 0 } : null;
}

/**
 * What the person typed as the start of the voiceover as a time for `voiceover.place`: seconds become a number, a
 * marker or grid reference stays text for the daemon's TimeRef rules (never parsed here); nothing typed is `undefined`
 * (right after the voice track's last clip).
 */
export function startOf(typed: string): number | string | undefined {
  const text = typed.trim();
  if (text === "") return undefined;
  return timeRefOf(text);
}

/** What the person is asked to confirm: the provider, how many lines it would say, and the estimate. */
export interface CostAsk {
  provider: string;
  lines: number;
  /** The estimated total as text (`0.04 USD`); null when the provider gives no estimate and does not declare itself free. */
  cost: string | null;
  /** True when this ask replaces one the person confirmed: the lines or the cost changed since (`ConfirmationStale`). */
  changed: boolean;
  /** The daemon's token of this ask; sent back with `yes` so the run is bound to what the person saw. */
  confirmation: string;
}

/** The ask inside a `ConfirmationRequired` or `ConfirmationStale` error of `voiceover.generate`; null for any other error. */
export function costAsk(error: unknown): CostAsk | null {
  if (!isAsk(error)) return null;
  const data = error.data as { provider?: string; lines?: string[]; cost?: { amount: number; currency: string } | null; confirmation?: string } | undefined;
  if (!data?.confirmation) return null;
  return { provider: data.provider ?? "", lines: data.lines?.length ?? 0, cost: data.cost ? formatCost(data.cost) : null, changed: error.code === ErrorCode.ConfirmationStale, confirmation: data.confirmation };
}

/**
 * Run `request` unconfirmed; when the daemon asks for the cost to be confirmed, `confirm` decides and a yes runs it again
 * (`runConfirmed`). Resolves null when the person declined, nothing having been generated. Other errors reach the caller.
 */
export function runVoiceover(
  request: (confirmed: Confirmed | null) => Promise<VoiceoverGenerateResult>,
  confirm: (ask: CostAsk) => Promise<boolean>,
): Promise<VoiceoverGenerateResult | null> {
  return runConfirmed(request, costAsk, confirm);
}
