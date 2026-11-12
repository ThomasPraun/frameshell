import { GLASS, resolveStyle } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import type { DaemonConnection } from "@frameshell/protocol";
import { executeTimeline, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip set --glass` / `--backdrop-*` (ADR 0031) from argv to the `clip.set` request.

/** A connection that answers `style.show` with `style` and records every other request. */
function stub(style: unknown) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "style.show") return { style };
      sent.push({ method, params });
      return { revision: 2, changes: { added: [], updated: ["c_card"], removed: [], range: null }, warnings: [] };
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("clip set --glass (#462)", () => {
  it("copies the style's glass, with the motion kit's numbers when the project has no style", async () => {
    const none = stub(null);
    await executeTimeline(none.conn, parseTimelineCommand(["clip", "set", "c_card"], { glass: true })!, "/p", true);
    expect(none.sent[0]).toMatchObject({ method: "clip.set", params: { clip: "c_card", backdrop: GLASS } });

    const styled = stub(resolveStyle({ schemaVersion: 1, glass: { cards: true, dim: 0.72 } }));
    await executeTimeline(styled.conn, parseTimelineCommand(["clip", "set", "c_card"], { glass: true, "backdrop-blur": "30" })!, "/p", true);
    expect(styled.sent[0]!.params["backdrop"]).toEqual({ blur: 30, saturate: 1.45, dim: 0.72 });
  });

  it("sets single numbers without the style, clears with --clear-backdrop, refuses both", () => {
    expect(parseTimelineCommand(["clip", "set", "c_card"], { "backdrop-dim": "0.6" })).toMatchObject({ params: { clip: "c_card", backdrop: { dim: 0.6 } } });
    expect(parseTimelineCommand(["clip", "set", "c_card"], { "backdrop-dim": "0.6" })).not.toHaveProperty("glassFromStyle");
    expect(parseTimelineCommand(["clip", "set", "c_card"], { "clear-backdrop": true })!.params).toEqual({ clip: "c_card", backdrop: null });
    expect(() => parseTimelineCommand(["clip", "set", "c_card"], { "clear-backdrop": true, glass: true })).toThrow(/--clear-backdrop alone/);
  });
});
