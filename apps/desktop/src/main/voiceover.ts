// The app's voiceover run (ADR 0034 decisions 12 and 20): the daemon refuses a paid generation with `ConfirmationRequired`
// and the cost it found; the app asks the person and sends `yes` with that ask's `confirmation` token only after they
// confirm, so a run whose lines or cost changed meanwhile (`ConfirmationStale`) asks again. No dialog code here, so it is testable.
import { ErrorCode, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";

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

/** What a confirmed run sends: `yes` and the token of the ask the person confirmed. */
export interface Confirmed {
  yes: true;
  confirmation: string;
}

/** `0.04 USD`: the amount to at most 4 decimals, then its currency. */
export function formatCost(cost: { amount: number; currency: string }): string {
  return `${Number(cost.amount.toFixed(4))} ${cost.currency}`;
}

/** The ask inside a `ConfirmationRequired` or `ConfirmationStale` error of `voiceover.generate`; null for any other error. */
export function costAsk(error: unknown): CostAsk | null {
  if (!(error instanceof RpcError) || (error.code !== ErrorCode.ConfirmationRequired && error.code !== ErrorCode.ConfirmationStale)) return null;
  const data = error.data as { provider?: string; lines?: string[]; cost?: { amount: number; currency: string } | null; confirmation?: string } | undefined;
  if (!data?.confirmation) return null;
  return { provider: data.provider ?? "", lines: data.lines?.length ?? 0, cost: data.cost ? formatCost(data.cost) : null, changed: error.code === ErrorCode.ConfirmationStale, confirmation: data.confirmation };
}

/**
 * Run `request` unconfirmed; when the daemon asks for the cost to be confirmed, `confirm` decides and a yes runs it again
 * with `yes` and the ask's token. When the run changed since (a new ask), the person is asked again with the new cost.
 * Resolves null when the person declined, nothing having been generated. Other errors reach the caller.
 */
export async function runVoiceover(
  request: (confirmed: Confirmed | null) => Promise<VoiceoverGenerateResult>,
  confirm: (ask: CostAsk) => Promise<boolean>,
): Promise<VoiceoverGenerateResult | null> {
  let confirmed: Confirmed | null = null;
  for (;;) {
    try {
      return await request(confirmed);
    } catch (error) {
      const ask = costAsk(error);
      if (!ask) throw error;
      if (!(await confirm(ask))) return null;
      confirmed = { yes: true, confirmation: ask.confirmation };
    }
  }
}
