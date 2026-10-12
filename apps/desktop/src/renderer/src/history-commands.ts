// Edit menu Undo and Redo in the renderer (#119): text fields first, then the timeline.
import type { HistoryCommand } from "../../shared/api.js";
import { elementOf, focusedWindow } from "./windows.js";

/** Text fields (inputs, Monaco, xterm) own their undo keys; the timeline's undo works everywhere else. */
export function editsText(target: EventTarget | null): boolean {
  const element = elementOf(target);
  if (!element) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes((element as HTMLInputElement).type);
}

let timelineHandler: ((command: HistoryCommand) => void) | null = null;

/**
 * Let the timeline panel take Edit menu Undo and Redo outside text fields.
 * One handler at a time; returns the function that removes it.
 */
export function handleTimelineHistory(handler: (command: HistoryCommand) => void): () => void {
  timelineHandler = handler;
  return () => {
    if (timelineHandler === handler) timelineHandler = null;
  };
}

/**
 * Listen once per window for the Edit menu's Undo and Redo. The menu has no
 * `undo` role, so a focused text field gets its native undo here (any screen,
 * timeline mounted or not, in the project window or a detached panel's);
 * elsewhere the command goes to the timeline panel, and does nothing
 * without one. Returns the unsubscribe function.
 */
export function listenHistoryCommands(): () => void {
  return window.frameshell.timeline.onHistoryCommand((command) => {
    const { document: focused } = focusedWindow();
    if (editsText(focused.activeElement)) focused.execCommand(command);
    else timelineHandler?.(command);
  });
}
