import { describe, expect, it } from "vitest";
import { type ShellProbe, resolveAgent, resolveMcpAgent, resolveSession } from "../src/session.js";

// Seam: the pure resolver, with the parent shell's pid and start time injected.
const shell = (ppid: number, started: string | null): ShellProbe => ({ ppid, startTime: () => started, process: () => null });

describe("resolveSession", () => {
  it("uses FRAMESHELL_SESSION when set", () => {
    expect(resolveSession({ FRAMESHELL_SESSION: "term-4f2a" }, shell(4242, "Mon Sep 28 10:00:00 2026"))).toBe("term-4f2a");
  });

  it("generates the same id for every call from one shell", () => {
    const probe = shell(4242, "Mon Sep 28 10:00:00 2026");
    const id = resolveSession({}, probe);
    expect(id).toMatch(/^sh-4242-[0-9a-f]{8}$/);
    expect(resolveSession({ FRAMESHELL_SESSION: "" }, probe)).toBe(id);
  });

  it("tells apart shells, and a later shell that reuses a pid", () => {
    const first = resolveSession({}, shell(4242, "Mon Sep 28 10:00:00 2026"));
    expect(resolveSession({}, shell(4343, "Mon Sep 28 10:00:00 2026"))).not.toBe(first);
    expect(resolveSession({}, shell(4242, "Tue Sep 29 09:00:00 2026"))).not.toBe(first);
  });

  it("falls back to the pid alone when the start time is unknown", () => {
    expect(resolveSession({}, shell(4242, null))).toBe("sh-4242");
  });
});

/** A process tree: pid → parent pid and command line. */
const tree = (ppid: number, procs: Record<number, [number, string]>): ShellProbe => ({
  ppid,
  startTime: () => null,
  process: (pid) => (procs[pid] ? { ppid: procs[pid][0], argv: procs[pid][1].split(" ") } : null),
});
const noParents = shell(4242, null);

describe("resolveAgent", () => {
  it("names no agent when nothing is set and no ancestor is one, leaving it to the app", () => {
    expect(resolveAgent({}, noParents)).toBeUndefined();
  });

  it("turns FRAMESHELL_AGENT into a label", () => {
    expect(resolveAgent({ FRAMESHELL_AGENT: "claude" }, noParents)).toBe("claude");
    expect(resolveAgent({ FRAMESHELL_AGENT: "Gemini CLI" }, noParents)).toBe("gemini-cli");
  });

  it("reads an empty FRAMESHELL_AGENT as no agent, overriding detection", () => {
    const underClaude = tree(10, { 10: [5, "-zsh"], 5: [1, "claude --resume"] });
    expect(resolveAgent({ FRAMESHELL_AGENT: "" }, underClaude)).toBeNull();
    expect(resolveAgent({ FRAMESHELL_AGENT: " / " }, underClaude)).toBeNull();
  });

  it("names the agent found among the parent processes, with the labels app terminals detect", () => {
    const underCodex = tree(10, { 10: [7, "sh -c frameshell status"], 7: [5, "node /opt/homebrew/bin/codex exec x"], 5: [1, "-zsh"] });
    expect(resolveAgent({}, underCodex)).toBe("codex");
    expect(resolveAgent({ FRAMESHELL_AGENT_COMMANDS: "codex=cx" }, underCodex)).toBe("cx");
    expect(resolveAgent({ FRAMESHELL_AGENT_COMMANDS: "codex=" }, underCodex)).toBeUndefined();
  });

  it("stops at an unreadable process and at a parent loop", () => {
    expect(resolveAgent({}, tree(10, { 10: [99, "-zsh"] }))).toBeUndefined();
    expect(resolveAgent({}, tree(10, { 10: [11, "-zsh"], 11: [10, "-zsh"] }))).toBeUndefined();
  });

  it("looks only a few levels up", () => {
    const procs: Record<number, [number, string]> = { 2: [1, "claude"] };
    for (let pid = 3; pid <= 12; pid++) procs[pid] = [pid - 1, "-zsh"];
    expect(resolveAgent({}, tree(12, procs))).toBeUndefined();
  });
});

describe("resolveMcpAgent", () => {
  const underCodex = tree(10, { 10: [1, "codex"] });

  it("labels the agent from the MCP client name, as app terminals label it", () => {
    expect(resolveMcpAgent({}, { name: "claude-code" }, underCodex)).toBe("claude");
    expect(resolveMcpAgent({}, { name: "Codex" }, noParents)).toBe("codex");
  });

  it("lets FRAMESHELL_AGENT override the client, an empty one meaning none", () => {
    expect(resolveMcpAgent({ FRAMESHELL_AGENT: "mine" }, { name: "claude-code" }, noParents)).toBe("mine");
    expect(resolveMcpAgent({ FRAMESHELL_AGENT: "" }, { name: "claude-code" }, noParents)).toBeNull();
  });

  it("falls back to the process chain without a usable client name", () => {
    expect(resolveMcpAgent({}, null, underCodex)).toBe("codex");
    expect(resolveMcpAgent({}, { name: "" }, underCodex)).toBe("codex");
    expect(resolveMcpAgent({}, null, noParents)).toBeUndefined();
  });
});
