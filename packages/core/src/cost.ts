/** An estimate for a refusal message: 4 decimals under 1 (`0.0123 USD`), else 2. */
export function formatCost(cost: { amount: number; currency: string }): string {
  return `${cost.amount.toFixed(cost.amount < 1 ? 4 : 2)} ${cost.currency}`;
}
