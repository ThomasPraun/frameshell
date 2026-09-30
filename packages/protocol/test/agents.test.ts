import { describe, expect, it } from "vitest";
import { AuthorSchema, agentAuthor, agentLabel, parseParams } from "../src/index.js";

describe("agent labels", () => {
  it("turns a free-form agent name into a label", () => {
    expect(agentLabel("claude")).toBe("claude");
    expect(agentLabel("Gemini CLI")).toBe("gemini-cli");
    expect(agentLabel("  My/Agent v2 ")).toBe("my-agent-v2");
  });

  it("has no label for a name without letters or digits", () => {
    expect(agentLabel("")).toBeNull();
    expect(agentLabel(" / ")).toBeNull();
  });

  it("caps a label at 32 characters", () => {
    expect(agentLabel("a".repeat(40))).toBe("a".repeat(32));
  });
});

describe("agent authors", () => {
  it("carry the label and the terminal session", () => {
    expect(agentAuthor("claude", "term-1a2b")).toBe("agent:claude:term-1a2b");
    expect(agentAuthor("codex", null)).toBe("agent:codex");
  });

  it("are valid journal authors", () => {
    expect(AuthorSchema.parse("agent:claude:term-1a2b")).toBe("agent:claude:term-1a2b");
    expect(AuthorSchema.parse("agent:codex")).toBe("agent:codex");
    expect(() => AuthorSchema.parse("agent:")).toThrow();
    expect(() => AuthorSchema.parse("agent:Bad Label")).toThrow();
  });

  it("are asked for in the handshake and set per session by the app", () => {
    const base = { protocolVersion: 1, client: "cli/test" };
    expect(parseParams("handshake", { ...base, agent: "claude" })).toMatchObject({ agent: "claude" });
    expect(parseParams("handshake", { ...base, agent: null })).toMatchObject({ agent: null });
    expect(() => parseParams("handshake", { ...base, agent: "Not A Label" })).toThrow(/agent/);
    expect(parseParams("session.tag", { session: "term-1", agent: "claude" })).toEqual({ session: "term-1", agent: "claude" });
    expect(parseParams("session.tag", { session: "term-1", agent: null })).toEqual({ session: "term-1", agent: null });
  });
});
