/** A box in a window's client coordinates. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Space kept between the tooltip and its control, and between the tooltip and the window's edges, in px. */
const GAP = 6;

/**
 * Where a tooltip of `size` goes for a control at `anchor` in a window of
 * `viewport` size: centered below the control, above it when there is no room
 * below, and shifted sideways to stay inside the window.
 */
export function placeTooltip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; side: "below" | "above" } {
  const below = anchor.top + anchor.height + GAP;
  const fitsBelow = below + size.height <= viewport.height - GAP;
  const above = anchor.top - GAP - size.height;
  const side = fitsBelow || above < GAP ? "below" : "above";
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(GAP, Math.min(centered, viewport.width - GAP - size.width));
  return { left, top: side === "below" ? below : above, side };
}
