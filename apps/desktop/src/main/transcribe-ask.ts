// The app's transcription ask (ADR 0046 decision 10): `transcribe` refuses a cloud or paid provider with
// `ConfirmationRequired` before any audio leaves the machine; the ask is the daemon's own, shown in a native box.
// No dialog code here, so it is testable. The loop is the one of voiceover (`confirmation.ts`).
import { ErrorCode, type MethodResult } from "@frameshell/protocol";
import { type Confirmed, formatCost, isAsk, runConfirmed } from "./confirmation.js";

/** What the person is asked to confirm: the provider, the file whose audio is uploaded, how long it is, and the estimate. */
export interface TranscribeAsk {
  provider: string;
  /** Model asked for; null = the provider's default. */
  model: string | null;
  /** Project-relative asset. */
  asset: string;
  /** Length of the audio the provider would get. */
  seconds: number;
  /** The estimated first pass as text (`0.03 USD`); null when the provider gives no estimate and does not declare itself free. */
  cost: string | null;
  /** True when the audio is uploaded to a service (`remote`); false when it only may leave the machine at an unknown cost. */
  remote: boolean;
  /** True when this ask replaces one the person confirmed: the file, its audio or the price changed since (`ConfirmationStale`). */
  changed: boolean;
  /** The daemon's token of this ask; sent back with `yes` so the run is bound to what the person saw. */
  confirmation: string;
}

/** The ask inside a `ConfirmationRequired` or `ConfirmationStale` error of `transcribe`; null for any other error. */
export function transcribeAsk(error: unknown): TranscribeAsk | null {
  if (!isAsk(error)) return null;
  const data = error.data as
    | { provider?: string; model?: string | null; asset?: string; seconds?: number; cost?: { amount: number; currency: string } | null; remote?: boolean; confirmation?: string }
    | undefined;
  if (!data?.confirmation) return null;
  return {
    provider: data.provider ?? "",
    model: data.model ?? null,
    asset: data.asset ?? "",
    seconds: data.seconds ?? 0,
    cost: data.cost ? formatCost(data.cost) : null,
    remote: data.remote === true,
    changed: error.code === ErrorCode.ConfirmationStale,
    confirmation: data.confirmation,
  };
}

/**
 * Run `request` unconfirmed; when the daemon asks (a cloud or paid provider), `confirm` decides and a yes runs it
 * again with `yes` and the ask's token. A run that changed since (a new ask) asks again. Resolves null when the person
 * declined, nothing having been sent. Other errors reach the caller. No consent is kept: the next run asks again.
 */
export function runTranscribe(
  request: (confirmed: Confirmed | null) => Promise<MethodResult<"transcribe">>,
  confirm: (ask: TranscribeAsk) => Promise<boolean>,
): Promise<MethodResult<"transcribe"> | null> {
  return runConfirmed(request, transcribeAsk, confirm);
}

/** `m:ss` (`h:mm:ss` from an hour), for the dialog. Twin of `formatLength` in `packages/core/src/transcripts/consent.ts` (private there). */
export function formatLength(seconds: number): string {
  const whole = Math.ceil(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
