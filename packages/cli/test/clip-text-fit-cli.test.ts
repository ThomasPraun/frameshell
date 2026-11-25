import type { ClipTextFitResult, DaemonConnection } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { executeTimeline, formatClipTextFit, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip text-fit` (#803) from argv to the `clip.textFit` request, the report and the exit code.

const failing: ClipTextFitResult = {
  timeline: "main",
  clip: "c_end",
  type: "hyperframes",
  ok: false,
  size: { width: 1920, height: 1080 },
  tried: ["cta"],
  at: [2, 2.8, 3.6],
  lines: 3,
  problems: [{ kind: "overflows", at: 3.6, by: 42.5, side: "right", selector: "#cta-text", text: "Jetzt kostenlos testen", box: { x: 800, y: 600, width: 360, height: 40 } }],
  warnings: [],
};
const passing: ClipTextFitResult = { ...failing, ok: true, tried: [], problems: [] };

function stub(result: ClipTextFitResult) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return result;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("clip text-fit", () => {
  it("sends the clip, the tried props and the times to clip.textFit", () => {
    expect(parseTimelineCommand(["clip", "text-fit", "c_end"], { props: '{"cta":"Jetzt kostenlos testen"}', at: "2.5,3" })).toMatchObject({
      method: "clip.textFit",
      params: { clip: "c_end", props: { cta: "Jetzt kostenlos testen" }, at: [2.5, 3] },
    });
    expect(parseTimelineCommand(["clip", "text-fit", "c_end"], {})!.params).toEqual({ clip: "c_end" });
  });

  it("refuses bad times, more than 12 of them, and other commands' flags", () => {
    expect(() => parseTimelineCommand(["clip", "text-fit", "c_end"], { at: "2,x" })).toThrow(/--at: expected composition seconds/);
    expect(() => parseTimelineCommand(["clip", "text-fit", "c_end"], { at: Array.from({ length: 13 }, (_, i) => i).join(",") })).toThrow(/1 to 12 times, got 13/);
    expect(() => parseTimelineCommand(["clip", "text-fit", "c_end"], { probes: "4" })).toThrow(/does not take --probes/);
  });

  it("exits 1 when something does not fit, and reports it", async () => {
    const inv = parseTimelineCommand(["clip", "text-fit", "c_end"], {})!;
    const bad = { code: 0 };
    const text = await executeTimeline(stub(failing).conn, inv, "/p", false, undefined, bad);
    expect(bad.code).toBe(1);
    expect(text).toMatch(/^FAIL · hyperframes clip c_end of main · 3 text elements at 1920x1080, 2 2.8 3.6 s · trying cta · 1 does not fit/);
    expect(text).toContain('#cta-text "Jetzt kostenlos testen" past its box by 42.5 px on the right at 3.600 s');
    const ok = { code: 0 };
    expect(await executeTimeline(stub(passing).conn, inv, "/p", false, undefined, ok)).toMatch(/^OK · /);
    expect(ok.code).toBe(0);
    expect(formatClipTextFit(passing)).not.toContain("Shorten");
  });
});
