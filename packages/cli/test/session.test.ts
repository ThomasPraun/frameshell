import { describe, expect, it } from "vitest";
import { type ShellProbe, resolveSession } from "../src/session.js";

// Seam: the pure resolver, with the parent shell's pid and start time injected.
const shell = (ppid: number, started: string | null): ShellProbe => ({ ppid, startTime: () => started });

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
