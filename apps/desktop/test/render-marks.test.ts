import type { ClipRenderInfo } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import type { ClipBox, TimelineLayout, TrackRow } from "../src/renderer/src/timeline/layout.js";
import { renderMark, withRenders } from "../src/renderer/src/timeline/render-marks.js";

const box = (id: string, kind: ClipBox["kind"]) => ({ id, kind, problem: null }) as unknown as ClipBox;
const layout = (clips: ClipBox[]) => ({ rows: [{ id: "v1", clips } as unknown as TrackRow] }) as unknown as TimelineLayout;
const info = (clip: string, state: ClipRenderInfo["state"], error: string | null = null) => ({ clip, state, error }) as ClipRenderInfo;

describe("render marks (#746)", () => {
  it("maps render states to what the lane shows", () => {
    expect(renderMark("ready")).toBe("ready");
    expect(renderMark("rendering")).toBe("pending");
    expect(renderMark("queued")).toBe("pending");
    expect(renderMark("failed")).toBe("failed");
    expect(renderMark("unavailable")).toBe("failed");
  });

  it("marks generated clips, and a failed one carries the whole reason as its problem", () => {
    const before = layout([box("c_gen", "generated"), box("c_bad", "generated"), box("c_media", "media")]);
    const renders = new Map([
      ["c_gen", info("c_gen", "ready")],
      ["c_bad", info("c_bad", "failed", "page crashed at 1.2 s")],
      ["c_media", info("c_media", "failed", "never")],
    ]);
    const after = withRenders(before, renders, (error) => `Render failed: ${error}`);
    const [gen, bad, media] = after.rows[0]!.clips;
    expect(gen).toMatchObject({ render: "ready", problem: null });
    expect(bad).toMatchObject({ render: "failed", problem: "Render failed: page crashed at 1.2 s" });
    expect(media).toBe(before.rows[0]!.clips[2]);
  });

  it("returns the same layout when there is nothing to mark", () => {
    const before = layout([box("c_media", "media")]);
    expect(withRenders(before, new Map(), String)).toBe(before);
    expect(withRenders(before, new Map([["x", info("x", "ready")]]), String)).toBe(before);
  });
});
