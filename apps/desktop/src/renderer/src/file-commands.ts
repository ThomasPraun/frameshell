// File commands of context menus, shared by the Explorer and the timeline: Reveal, Copy path, Move to Trash.
import type { MenuItem } from "./components/ContextMenu.js";
import { t } from "./i18n.js";

const agent = navigator.userAgent;
const PLATFORM = agent.includes("Mac") ? "mac" : agent.includes("Windows") ? "windows" : "linux";

/** "Reveal in Finder", or the platform's file manager. */
export function revealLabel(): string {
  return t.editor.reveal(PLATFORM);
}

/** {@link revealLabel} for project-relative `path`. */
export function revealItem(path: string, separated = false): MenuItem {
  return { label: revealLabel(), separated, run: () => void window.frameshell.files.reveal(path) };
}

/** Reveal, Copy path, then Move to Trash (main asks first; the OS trash is the undo) for project-relative `path`. */
export function placeItems(path: string): MenuItem[] {
  const files = window.frameshell.files;
  return [
    revealItem(path, true),
    { label: t.editor.copyPath, run: () => void files.copyPath(path) },
    { label: t.editor.moveToTrash(PLATFORM === "windows"), separated: true, danger: true, run: () => void files.trash(path) },
  ];
}
