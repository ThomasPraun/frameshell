// "New image from frame" (ADR 0017): Mod+Shift+S, File menu, preview context menu. Main asks the size and opens the new project.
import { transport } from "./preview/transport.js";
import { SELECTION_TIMELINE } from "./selection.js";

/** Shortcut as menus show it. */
export const FRAME_IMAGE_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘⇧S" : "Ctrl+Shift+S";

/** The command's key: Mod+Shift+S, no Alt. */
export function isFrameImageKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "s";
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
    return await window.frameshell.project.imageFromFrame(SELECTION_TIMELINE, transport.get().time);
  } finally {
    running = false;
  }
}
