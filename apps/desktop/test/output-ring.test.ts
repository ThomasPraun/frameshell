import { describe, expect, it } from "vitest";
import { OUTPUT_RING_LIMITS, OutputRing } from "../src/main/output-ring.js";

// Seam under test: the output main keeps per terminal for `terminal:attach` (ADR 0012). What a fresh xterm is fed
// must draw what the program drew: whole recent lines, and the modes the program set before them.

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => `line ${from + k}\r\n`).join("");

describe("OutputRing", () => {
  it("replays everything while under its limits", () => {
    const ring = new OutputRing({ lines: 100, size: 10_000 });
    ring.append("$ ");
    ring.append("echo hi\r\nhi\r\n$ ");
    expect(ring.snapshot()).toBe("$ echo hi\r\nhi\r\n$ ");
  });

  it("drops the oldest lines past its line limit, at a line start", () => {
    const ring = new OutputRing({ lines: 100, size: 1_000_000 });
    for (let at = 0; at < 1000; at += 10) ring.append(lines(at, at + 10));
    const kept = ring.snapshot();
    // Trims back to the limit once a quarter over it, so between 100 and 125 lines stay, ending at the last one.
    const count = kept.split("\n").length - 1;
    expect(count).toBeGreaterThanOrEqual(100);
    expect(count).toBeLessThanOrEqual(125);
    expect(kept.startsWith("line ")).toBe(true);
    expect(kept.endsWith("line 999\r\n")).toBe(true);
  });

  it("drops the oldest output past its size limit, at a line start when one is near", () => {
    const ring = new OutputRing({ lines: 1_000_000, size: 1000 });
    for (let at = 0; at < 1000; at += 10) ring.append(lines(at, at + 10));
    const kept = ring.snapshot();
    expect(kept.length).toBeGreaterThanOrEqual(1000 - 20);
    expect(kept.length).toBeLessThanOrEqual(1250);
    expect(kept.startsWith("line ")).toBe(true);
    expect(kept.endsWith("line 999\r\n")).toBe(true);
  });

  it("cuts output without line breaks at the cap, never inside a surrogate pair", () => {
    const ring = new OutputRing({ lines: 100, size: 101 });
    ring.append("😀".repeat(200));
    const kept = ring.snapshot();
    expect(kept.length).toBeLessThanOrEqual(102);
    expect(kept.length % 2).toBe(0);
    expect(kept).toBe("😀".repeat(kept.length / 2));
  });

  it("replays the modes set in dropped output first, as they stood where the kept output starts", () => {
    const ring = new OutputRing({ lines: 10, size: 100_000 });
    // Bracketed paste on, then the alternate screen on and off again, all scrolled out.
    ring.append("\x1b[?2004h\x1b[?1049;1h\r\n\x1b[?1049l\r\n");
    ring.append(lines(0, 20));
    const kept = ring.snapshot();
    expect(kept.startsWith("\x1b[?2004h\x1b[?1049l\x1b[?1h")).toBe(true);
    expect(kept.endsWith("line 19\r\n")).toBe(true);
    // A mode still in the kept output is not repeated before it.
    ring.append("\x1b[?2004l");
    expect(ring.snapshot().endsWith("\x1b[?2004l")).toBe(true);
  });

  it("defaults to about 10,000 lines and 4 MiB", () => {
    expect(OUTPUT_RING_LIMITS).toEqual({ lines: 10_000, size: 4 * 1024 * 1024 });
  });
});
