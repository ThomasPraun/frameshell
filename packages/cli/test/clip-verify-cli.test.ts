import type { ClipVerifyResult, DaemonConnection } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { executeTimeline, formatClipVerify, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip verify` (ADR 0033) from argv to the `clip.verify` request, the report and the exit code.

const passing: ClipVerifyResult = {
  timeline: "main",
  clip: "c_motion",
  type: "hyperframes",
  ok: true,
  tolerance: 2,
  size: { width: 1920, height: 1080 },
  probes: [
    { at: 0.031, reseekFrom: 0.531, max: 0, pixels: 0, ok: true },
    { at: 0.115, reseekFrom: 0.615, max: 1, pixels: 0, ok: true },
  ],
  distinct: 2,
  worst: { at: 0.115, max: 1, pixel: { x: 4, y: 9 }, element: null },
  warnings: [],
};

const failing: ClipVerifyResult = {
  ...passing,
  ok: false,
  probes: [{ at: 0.031, reseekFrom: 0.531, max: 211, pixels: 340, ok: false }, passing.probes[1]!],
  worst: { at: 0.031, max: 211, pixel: { x: 120, y: 44 }, element: { selector: "#scene > h1.title", tag: "h1", id: null, classes: ["title"], text: "Launch", box: { x: 100, y: 30, width: 400, height: 90 } } },
  warnings: ["Every probe frame is the same picture: the clip does not move."],
};

function stub(result: ClipVerifyResult) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return result;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("clip verify", () => {
  it("sends the clip, probes and tolerance to clip.verify, on the given timeline", () => {
    expect(parseTimelineCommand(["clip", "verify", "c_motion"], { timeline: "intro", probes: "6", tolerance: "4" })).toMatchObject({
      method: "clip.verify",
      withCwd: true,
      params: { timeline: "intro", clip: "c_motion", probes: 6, tolerance: 4 },
    });
    // Unset: the daemon's defaults (12 probes, 2/255).
    expect(parseTimelineCommand(["clip", "verify", "c_motion"], {})!.params).toEqual({ clip: "c_motion" });
  });

  it("refuses probe counts and tolerances out of range, other commands' flags, and a missing clip", () => {
    expect(() => parseTimelineCommand(["clip", "verify", "c_motion"], { probes: "1" })).toThrow(/--probes: expected a whole number from 2 to 48/);
    expect(() => parseTimelineCommand(["clip", "verify", "c_motion"], { probes: "49" })).toThrow(/--probes/);
    expect(() => parseTimelineCommand(["clip", "verify", "c_motion"], { tolerance: "256" })).toThrow(/--tolerance: expected a whole number from 0 to 255/);
    expect(() => parseTimelineCommand(["clip", "verify", "c_motion"], { tolerance: "1.5" })).toThrow(/--tolerance/);
    expect(() => parseTimelineCommand(["clip", "verify", "c_motion"], { speed: "2" })).toThrow(/does not take --speed/);
    expect(() => parseTimelineCommand(["clip", "verify"], {})).toThrow(/takes 1 argument/);
  });

  it("exits 0 on a pass and 1 on a fail, in text and in --json", async () => {
    const inv = parseTimelineCommand(["clip", "verify", "c_motion"], {})!;
    const ok = { code: 0 };
    expect(await executeTimeline(stub(passing).conn, inv, "/p", false, undefined, ok)).toMatch(/^OK · hyperframes clip c_motion/);
    expect(ok.code).toBe(0);

    const bad = { code: 0 };
    const text = await executeTimeline(stub(failing).conn, inv, "/p", false, undefined, bad);
    expect(bad.code).toBe(1);
    expect(text).toMatch(/^FAIL · hyperframes clip c_motion of main · 2 probes at 1920x1080, 2 different pictures · tolerance 2\/255 · 1 of 2 probes differ/);

    const json = { code: 0 };
    const raw = await executeTimeline(stub(failing).conn, inv, "/p", true, undefined, json);
    expect(JSON.parse(raw)).toMatchObject({ ok: false, worst: { max: 211, element: { selector: "#scene > h1.title" } } });
    expect(json.code).toBe(1);
  });
});

describe("formatClipVerify", () => {
  it("lists every probe, then the worst frame with its element, the warnings and what to look for", () => {
    const text = formatClipVerify(failing);
    expect(text).toContain("   0.031 s  after 0.531 s  max 211/255  340 px over  DIFFERS");
    expect(text).toContain("   0.115 s  after 0.615 s  max   1/255  0 px over  ok");
    expect(text).toContain('Worst: 0.031 s, pixel 120,44, 211/255 · #scene > h1.title "Launch"');
    expect(text).toContain("warning: Every probe frame is the same picture");
    expect(text).toContain("CSS transitions, timers");
  });

  it("says nothing paints a transparent worst pixel, and adds no advice to a pass", () => {
    const text = formatClipVerify(passing);
    expect(text).toContain("Worst: 0.115 s, pixel 4,9, 1/255 · nothing paints there (transparent)");
    expect(text).not.toContain("CSS transitions");
  });
});
