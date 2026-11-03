import type { AgentTarget } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { chatTargets, deliveryAfterRead, pendingTargets, shortcutTarget, targetName } from "../src/renderer/src/ask/chat-targets.js";

// Seam under test: who "Chat about this" reaches (ADR 0025): agents in the app's terminals and outside it, as equals.

const external = (id: string, fields: Partial<AgentTarget> = {}): AgentTarget => ({
  id,
  kind: "mcp",
  client: id,
  title: null,
  connections: 1,
  pending: 0,
  ...fields,
});
const label = (name: string) => `${name} · launch`;

describe("chatTargets", () => {
  it("lists terminals running an agent first, then connected outside agents named by their title", () => {
    const targets = chatTargets(
      [
        { key: 3, label: "Terminal 2 (codex)" },
        { key: 0, label: "Terminal 1 (claude)" },
      ],
      [external("claude", { client: "claude-code", title: "Claude Code" }), external("terminal", { kind: "cli" })],
      label,
    );
    expect(targets).toEqual([
      { kind: "terminal", id: "terminal:3", key: 3, label: "Terminal 2 (codex)" },
      { kind: "terminal", id: "terminal:0", key: 0, label: "Terminal 1 (claude)" },
      { kind: "external", id: "agent:claude", target: "claude", label: "Claude Code · launch" },
      { kind: "external", id: "agent:terminal", target: "terminal", label: "terminal · launch" },
    ]);
  });

  it("leaves out an outside agent with no connection left, even while references wait for it", () => {
    expect(chatTargets([], [external("codex", { connections: 0, pending: 2 })], label)).toEqual([]);
  });
});

describe("shortcutTarget", () => {
  const targets = chatTargets([{ key: 1, label: "Terminal 1 (claude)" }], [external("codex")], label);

  it("goes to the target used last while it is there, else the first", () => {
    expect(shortcutTarget(targets, "agent:codex")?.id).toBe("agent:codex");
    expect(shortcutTarget(targets, "agent:gone")?.id).toBe("terminal:1");
    expect(shortcutTarget(targets, null)?.id).toBe("terminal:1");
    expect(shortcutTarget([], null)).toBeNull();
  });
});

describe("pending and delivery", () => {
  it("counts what each outside agent has not read, connected or not", () => {
    expect(
      pendingTargets([external("claude", { title: "Claude Code", pending: 2 }), external("codex"), external("terminal", { connections: 0, pending: 1 })]),
    ).toEqual([
      { id: "claude", name: "Claude Code", pending: 2 },
      { id: "terminal", name: "terminal", pending: 1 },
    ]);
    expect(targetName(external("codex", { client: "Codex" }))).toBe("Codex");
  });

  it("marks the delivery read only when the target waited for reads", () => {
    const waiting = { target: "claude", name: "Claude Code", read: false, at: 1 };
    expect(deliveryAfterRead(waiting, "codex", 5)).toBe(waiting);
    expect(deliveryAfterRead(waiting, null, 5)).toBe(waiting);
    expect(deliveryAfterRead(waiting, "claude", 5)).toEqual({ ...waiting, read: true, at: 5 });
    expect(deliveryAfterRead(null, "claude", 5)).toBeNull();
  });
});
