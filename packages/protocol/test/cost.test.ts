import { describe, expect, it } from "vitest";
import { formatCost } from "../src/index.js";

describe("formatCost", () => {
  const usd = (amount: number) => formatCost({ amount, currency: "USD" });

  it("writes exactly 0 as 0, and a positive amount that rounds to zero as a floor", () => {
    expect(usd(0)).toBe("0 USD");
    expect(usd(0.00004)).toBe("< 0.0001 USD");
    expect(usd(0.00005)).toBe("0.0001 USD");
  });

  it("keeps 4 decimals under 1 and 2 from 1", () => {
    expect(usd(0.0126)).toBe("0.0126 USD");
    expect(usd(0.5)).toBe("0.5000 USD");
    expect(usd(1)).toBe("1.00 USD");
    expect(usd(0.99996)).toBe("1.00 USD");
    expect(formatCost({ amount: 1.5, currency: "EUR" })).toBe("1.50 EUR");
  });
});
