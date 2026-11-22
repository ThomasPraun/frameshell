// The pure parts of the app's voiceover (ADR 0034 decisions 12, 18 and 20), testable with no dialog code: the cost ask
// of a paid generation (`costAsk`, run through the shared confirm loop in `confirmation.ts`), progress, Cancel, the
// misread check's plan and where placing starts.
import { ErrorCode, type Progress, RpcError, type VoiceoverGenerateResult, formatCost, timeRefOf } from "@frameshell/protocol";
import { DEFAULT_TRANSCRIPTION_PROVIDER } from "@frameshell/schema";
import type { VoiceoverPlaceRun, VoiceoverProgress, VoiceoverVerifyPlan } from "../shared/api.js";
import { type Confirmed, isAsk, runConfirmed } from "./confirmation.js";

/** Transcription provider the app can set up and size a download for (`transcriptionDownload` in `main/index.ts`). */
export const APP_TRANSCRIPTION_PROVIDER = DEFAULT_TRANSCRIPTION_PROVIDER;

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
  if (update.stage?.includes("download")) return { stage: "download", line: null, fraction, place: null };
  const index = update.values?.["index"];
  const total = update.values?.["total"];
  const place = typeof index === "number" && typeof total === "number" ? { index, total } : null;
  return { stage: update.stage === "speak" ? "speak" : "verify", line, fraction, place };
}

/**
 * A generation that could not start for want of a voice (#756): no provider named in the script (`available` = the
 * providers there are, from the error), or the named one not in this project (`missing`). Null for any other error.
 */
export function missingVoice(error: unknown): { missing: string | null; available: string[] } | null {
  if (!(error instanceof RpcError)) return null;
  const data = error.data as { provider?: unknown; available?: unknown; issues?: { path?: unknown[] }[] } | undefined;
  const available = Array.isArray(data?.available) ? data.available.filter((id): id is string => typeof id === "string") : [];
  if (error.code === ErrorCode.SpeechProviderNotFound) return { missing: typeof data?.provider === "string" ? data.provider : null, available };
  if (error.code === ErrorCode.InvalidParams && data?.issues?.[0]?.path?.[0] === "provider") return { missing: null, available };
  return null;
}

/** Why `voiceover.place` refused, in terms the dialog words itself (#756); `other` keeps the daemon's message. */
export type PlaceRefusal = Extract<VoiceoverPlaceRun, { status: "refused" }>["reason"];

/** What a refusal of `voiceover.place` was about. */
export function placeRefusal(error: unknown): PlaceRefusal {
  const message = (error as Error)?.message ?? String(error);
  if (!(error instanceof RpcError)) return { kind: "other", message };
  const data = error.data as { field?: unknown; value?: unknown; hint?: unknown; reason?: unknown; issues?: { path?: unknown[] }[] } | undefined;
  if (error.code === ErrorCode.InvalidParams && data?.issues?.some((issue) => issue.path?.[0] === "start")) return { kind: "before-zero" };
  if (error.code !== ErrorCode.InvalidOperation) return { kind: "other", message };
  if (data?.field === "replace") return { kind: "replace" };
  if (data?.field === "start") {
    const said = `${typeof data.reason === "string" ? data.reason : ""} ${typeof data.hint === "string" ? data.hint : ""}`;
    if (/tempo/i.test(said)) return { kind: "no-tempo" };
    return { kind: "unknown-time", value: typeof data.value === "string" ? data.value : String(data.value ?? "") };
  }
  return { kind: "other", message };
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
  // A decimal comma, as Spanish writes it (#756): "2,5" is 2.5 seconds, never a marker.
  return timeRefOf(/^-?\d+,\d+$/.test(text) ? text.replace(",", ".") : text);
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
