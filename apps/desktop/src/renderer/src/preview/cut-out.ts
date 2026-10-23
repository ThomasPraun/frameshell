import { SELECTION_TIMELINE, type Selection } from "../selection.js";

/** A photo part that can be cut out as a layer: the picked clip and the chosen mask's project-relative PNG. */
export interface Cutout {
  clip: string;
  mask: string;
}

/**
 * What "Cut out as layer" would cut: the last picked point that landed on a clip and was segmented
 * (ADR 0022), with the mask the model scored best; null when no such point is selected.
 */
export function pickedCutout(selected: Pick<Selection, "points">): Cutout | null {
  for (const point of [...selected.points].reverse()) {
    const mask = point.segment?.masks[point.segment.chosen]?.mask;
    if (point.target && mask) return { clip: point.target, mask };
  }
  return null;
}

/** Cut the picked part out as a new layer above its photo (one undoable step); resolves with the new clip id. */
export function cutOut(picked: Cutout): Promise<string> {
  return window.frameshell.timeline.cutOut(SELECTION_TIMELINE, picked.clip, picked.mask);
}
