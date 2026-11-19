// The app's one confirm loop for paid or remote daemon runs (ADR 0034 decisions 12 and 20, ADR 0046 decision 10): the daemon
// refuses with `ConfirmationRequired` and what it found; the app asks the person and sends `yes` with that ask's
// `confirmation` token only after they confirm, so a run that changed meanwhile (`ConfirmationStale`) asks again.
// No dialog code here, so it is testable. Voiceover (`voiceover.ts`) and transcription (`transcribe-ask.ts`) read their asks.
import { ErrorCode, RpcError } from "@frameshell/protocol";

/** What a confirmed run sends: `yes` and the token of the ask the person confirmed. */
export interface Confirmed {
  yes: true;
  confirmation: string;
}

/** `0.04 USD`: the amount to at most 4 decimals, then its currency. */
export function formatCost(cost: { amount: number; currency: string }): string {
  return `${Number(cost.amount.toFixed(4))} ${cost.currency}`;
}

/** True for the two errors that carry an ask: `ConfirmationRequired` and `ConfirmationStale`. */
export function isAsk(error: unknown): error is RpcError {
  return error instanceof RpcError && (error.code === ErrorCode.ConfirmationRequired || error.code === ErrorCode.ConfirmationStale);
}

/**
 * Run `request` unconfirmed; when the daemon asks (`askOf` reads its error), `confirm` decides and a yes runs it again
 * with `yes` and the ask's token. When the run changed since (a new ask), the person is asked again with the new data.
 * Resolves null when the person declined, nothing having been run. Other errors reach the caller.
 */
export async function runConfirmed<T, A extends { confirmation: string }>(
  request: (confirmed: Confirmed | null) => Promise<T>,
  askOf: (error: unknown) => A | null,
  confirm: (ask: A) => Promise<boolean>,
): Promise<T | null> {
  let confirmed: Confirmed | null = null;
  for (;;) {
    try {
      return await request(confirmed);
    } catch (error) {
      const ask = askOf(error);
      if (!ask) throw error;
      if (!(await confirm(ask))) return null;
      confirmed = { yes: true, confirmation: ask.confirmation };
    }
  }
}
