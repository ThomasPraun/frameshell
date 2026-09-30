// "Ask agent" (SPEC decision 21): one command, run from Cmd/Ctrl+L or any panel's context menu.
import type { MouseEvent } from "react";
import { contextMenu } from "../components/ContextMenu.js";
import { SELECTION_TIMELINE, type Selection, selection } from "../selection.js";
import { timelineSnapshot } from "../timeline/useTimelineView.js";
import { referenceLines } from "./reference.js";

const isMac = navigator.userAgent.includes("Mac");

/** Shortcut as menus show it. */
export const ASK_SHORTCUT = isMac ? "⌘L" : "Ctrl+L";

let handler: (() => void) | null = null;

/**
 * The command. The workspace installs what it does (it owns the terminal
 * panel and its collapsed state); panels only call {@link askAgent.run}.
 */
export const askAgent = {
  /** Ask about the current selection; no-op before the workspace is up. */
  run(): void {
    handler?.();
  },
  /** Make `next` the command; returns an uninstall function. */
  install(next: () => void): () => void {
    handler = next;
    return () => {
      if (handler === next) handler = null;
    };
  },
};

/** True when `current` holds anything a reference can name. */
export function hasSelection(current: Selection): boolean {
  return (
    current.clips.length > 0 ||
    current.words.length > 0 ||
    current.range !== null ||
    current.history !== null ||
    current.files.length > 0 ||
    current.scene !== null ||
    current.region !== null
  );
}

/**
 * Reference lines of the current selection, on the shared timeline feed's
 * latest revision. A preview region first gets its frame captured by the
 * daemon; when that fails the line goes without it and `warning` says why.
 */
export async function composeReference(): Promise<{ lines: string[]; warning: string | null }> {
  const current = selection.get();
  let frame: string | null = null;
  let warning: string | null = null;
  if (current.region) {
    try {
      frame = await window.frameshell.context.captureFrame(current.region.at);
    } catch (error) {
      warning = `Frame not captured: ${(error as Error).message}`;
    }
  }
  return { lines: referenceLines(current, timelineSnapshot(SELECTION_TIMELINE), { frame }), warning };
}

/**
 * Open the "Ask agent" context menu at the pointer. Call after the panel
 * has selected what was right-clicked; the entry is disabled with nothing selected.
 */
export function openAskMenu(event: MouseEvent): void {
  event.preventDefault();
  contextMenu.open(event.clientX, event.clientY, [
    { label: "Ask agent", shortcut: ASK_SHORTCUT, disabled: !hasSelection(selection.get()), run: () => askAgent.run() },
  ]);
}
