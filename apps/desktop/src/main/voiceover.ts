// The app's voiceover run (ADR 0034 decision 12): the daemon refuses a paid generation with `ConfirmationRequired` and
// the cost it found; the app asks the person and sends `yes` only after they confirm. No dialog code here, so it is testable.
import { ErrorCode, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";

/** What the person is asked to confirm: the provider, how many lines it would say, and the estimate. */
export interface CostAsk {
  provider: string;
  lines: number;
  /** The estimated total as text (`0.04 USD`); null when the provider gives no estimate and does not declare itself free. */
  cost: string | null;
}

/** `0.04 USD`: the amount to at most 4 decimals, then its currency. */
export function formatCost(cost: { amount: number; currency: string }): string {
  return `${Number(cost.amount.toFixed(4))} ${cost.currency}`;
}

/** The ask inside a `ConfirmationRequired` error of `voiceover.generate`; null for any other error. */
export function costAsk(error: unknown): CostAsk | null {
  if (!(error instanceof RpcError) || error.code !== ErrorCode.ConfirmationRequired) return null;
  const data = error.data as { provider?: string; lines?: string[]; cost?: { amount: number; currency: string } | null } | undefined;
  return { provider: data?.provider ?? "", lines: data?.lines?.length ?? 0, cost: data?.cost ? formatCost(data.cost) : null };
}

/**
 * Run `request` without `yes`; when the daemon asks for the cost to be confirmed, `confirm` decides and a yes runs it again
 * with `yes: true`. Resolves null when the person declined, nothing having been generated. Other errors reach the caller.
 */
export async function runVoiceover(
  request: (yes: boolean) => Promise<VoiceoverGenerateResult>,
  confirm: (ask: CostAsk) => Promise<boolean>,
): Promise<VoiceoverGenerateResult | null> {
  try {
    return await request(false);
  } catch (error) {
    const ask = costAsk(error);
    if (!ask) throw error;
    return (await confirm(ask)) ? request(true) : null;
  }
}
