// "Ask agent" (SPEC decision 21): one command, run from Cmd/Ctrl+L or any panel's context menu.
import type { MouseEvent } from "react";
import { type MenuItem, contextMenu } from "../components/ContextMenu.js";
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
 * The capture waits for every generated clip's render, so while one is
 * queued, rendering or failed the line says `frame pending` instead and is
 * typed at once (ADR 0011): the agent captures the frame later.
 */
export async function composeReference(): Promise<{ lines: string[]; warning: string | null }> {
  const current = selection.get();
  let frame: string | null = null;
  let framePending = false;
  let warning: string | null = null;
  if (current.region) {
    framePending = await rendersPending();
    if (!framePending) {
      try {
        frame = await window.frameshell.context.captureFrame(current.region.at);
      } catch (error) {
        warning = `Frame not captured: ${(error as Error).message}`;
      }
    }
  }
  return { lines: referenceLines(current, timelineSnapshot(SELECTION_TIMELINE), { frame, framePending }), warning };
}

/** True while a generated clip of the timeline has no render the frame capture could use without waiting. */
async function rendersPending(): Promise<boolean> {
  try {
    const { clips } = await window.frameshell.clips.renders(SELECTION_TIMELINE);
    return clips.some((clip) => clip.state === "queued" || clip.state === "rendering" || clip.state === "failed");
  } catch {
    // Unknown: try the capture, which says what is wrong.
    return false;
  }
}

/**
 * Open the "Ask agent" context menu at the pointer. Call after the panel
 * has selected what was right-clicked; the entry is disabled with nothing selected.
 * `extra` entries (the panel's own commands) follow it.
 */
export function openAskMenu(event: MouseEvent, extra: readonly MenuItem[] = []): void {
  event.preventDefault();
  contextMenu.open(event.clientX, event.clientY, [
    { label: "Ask agent", shortcut: ASK_SHORTCUT, disabled: !hasSelection(selection.get()), run: () => askAgent.run() },
    ...extra,
  ]);
}
