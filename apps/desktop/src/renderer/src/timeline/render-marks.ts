import type { ClipRenderInfo } from "@frameshell/protocol";
import type { TimelineLayout } from "./layout.js";

/** What the timeline shows of a generated clip's render (#746): hatched while pending, plain once ready, red when failed. */
export type ClipRenderMark = "ready" | "pending" | "failed";

/** {@link ClipRenderMark} of one `clip.renders` state. */
export function renderMark(state: ClipRenderInfo["state"]): ClipRenderMark {
  return state === "ready" ? "ready" : state === "failed" || state === "unavailable" ? "failed" : "pending";
}

/**
 * `layout` with the render state of each generated clip of its own tracks (nested clips are the nested timeline's):
 * a failed or unavailable render carries `failed(error)` as its `renderError`, so the lane paints it red and the
 * tooltip says why (#746). The clip stays editable like any other: its length is known. Clips without a known render
 * are left as they are; same object when none changes.
 */
export function withRenders(layout: TimelineLayout, renders: ReadonlyMap<string, ClipRenderInfo>, failed: (error: string) => string): TimelineLayout {
  if (renders.size === 0) return layout;
  let changed = false;
  const rows = layout.rows.map((row) => {
    let rowChanged = false;
    const clips = row.clips.map((clip) => {
      const info = clip.kind === "generated" ? renders.get(clip.id) : undefined;
      if (!info) return clip;
      const mark = renderMark(info.state);
      rowChanged = true;
      return { ...clip, render: mark, ...(mark === "failed" ? { renderError: failed(info.error ?? info.state) } : {}) };
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, clips };
  });
  return changed ? { ...layout, rows } : layout;
}
