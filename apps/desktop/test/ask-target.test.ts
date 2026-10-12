import { describe, expect, it } from "vitest";
import { askTarget } from "../src/renderer/src/ask/ask-target.js";

// Seam under test: which terminal "Ask agent" types into (ADR 0012), whatever window each terminal is in.

const tab = (key: number, id: string | null, exitCode: number | null = null) => ({ key, info: id ? { id } : null, exitCode });

describe("askTarget", () => {
  const tabs = [tab(0, "t0"), tab(1, "t1"), tab(2, "t2"), tab(3, null)];

  it("prefers the most recently focused terminal running an agent", () => {
    const agents = new Map([
      ["t0", "claude"],
      ["t2", "codex"],
    ]);
    expect(askTarget(tabs, 1, agents, [2, 0, 1])?.key).toBe(0);
    expect(askTarget(tabs, 1, agents, [0, 2, 1])?.key).toBe(2);
  });

  it("falls back to the most recently focused terminal, then the active one, then the first", () => {
    const none = new Map<string, string>();
    expect(askTarget(tabs, 1, none, [0, 2])?.key).toBe(2);
    // An agent in a terminal never focused is not a target before a focused one.
    expect(askTarget(tabs, 1, new Map([["t3", "claude"]]), [0])?.key).toBe(0);
    expect(askTarget(tabs, 1, none, [])?.key).toBe(1);
    expect(askTarget(tabs, -1, none, [])?.key).toBe(0);
  });

  it("skips exited terminals and keys of closed tabs", () => {
    const exited = [tab(0, "t0", 0), tab(1, "t1"), tab(2, "t2", 1)];
    expect(askTarget(exited, 0, new Map([["t0", "claude"]]), [1, 9, 0])?.key).toBe(1);
    expect(askTarget([tab(0, "t0", 0)], 0, new Map(), [0])).toBeNull();
    expect(askTarget([], -1, new Map(), [])).toBeNull();
  });
});
