/** A price as a number and its currency, as providers estimate it and refusals carry it. */
export interface Cost {
  /** Price in units of `currency`, never negative. */
  amount: number;
  /** Currency code as the provider states it (`USD`). */
  currency: string;
}

/**
 * The one text of a cost, for refusal messages and the app's confirmation boxes: `0 USD` for exactly 0, 4 decimals
 * under 1 (`0.0126 USD`), else 2 (`1.50 USD`). A positive amount that would round to zero reads `< 0.0001 USD`,
 * so a price is never shown as nothing.
 */
export function formatCost(cost: Cost): string {
  const { amount, currency } = cost;
  if (amount > 0 && amount < 0.00005) return `< 0.0001 ${currency}`;
  if (amount === 0) return `0 ${currency}`;
  const small = amount.toFixed(4);
  return `${(amount < 1 && small !== "1.0000" ? small : amount.toFixed(2))} ${currency}`;
}
