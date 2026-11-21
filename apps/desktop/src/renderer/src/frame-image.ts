// "New image from frame" (ADR 0017): Mod+Shift+S, File menu, preview context menu. Main asks the size and opens the new project.
import { transport } from "./preview/transport.js";
import { SELECTION_TIMELINE } from "./selection.js";
import { shortcutLabel } from "./shortcuts.js";

/** Shortcut as menus show it. */
export const FRAME_IMAGE_SHORTCUT = shortcutLabel("Mod+Shift+S");

/** The command's key: Mod+Shift+S, no Alt. */
export function isFrameImageKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "s";
}

/**
 * The time of the frame shown at `time`: a playhead parked at the very end (`frames / fps`) shows the last frame,
 * which starts one frame earlier (#751: asking for the end failed after the size question).
 */
export function shownFrameTime(time: number, frames: number, fps: number): number {
  if (frames <= 0 || fps <= 0) return Math.max(0, time);
  return Math.min(Math.max(0, time), (frames - 1) / fps);
}

let running = false;

/**
 * Pause and make an image project from the frame at the playhead. Resolves with the new project's folder, or
 * null when cancelled or while an earlier request still runs (a key repeat, the key and the menu both firing).
 */
export async function imageFromFrame(): Promise<string | null> {
  if (running) return null;
  running = true;
  try {
    transport.pause();
    const { time, frames, fps } = transport.get();
    return await window.frameshell.project.imageFromFrame(SELECTION_TIMELINE, shownFrameTime(time, frames, fps));
  } finally {
    running = false;
  }
}
