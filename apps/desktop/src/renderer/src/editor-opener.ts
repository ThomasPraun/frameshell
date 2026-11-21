// Opening a project file in the editor from any panel of the project window (#746: a generated clip's composition).
import { useSyncExternalStore } from "react";

let opener: ((path: string) => void) | null = null;
const listeners = new Set<() => void>();

/**
 * Set the function that opens a file in this window's editor (the workspace's), or null when it goes away. A detached
 * panel window has its own renderer and no editor, so nothing registers there.
 */
export function registerEditorOpener(open: ((path: string) => void) | null): void {
  opener = open;
  for (const listener of listeners) listener();
}

/** Open project-relative `path` in this window's editor; false when this window has none. */
export function openInEditor(path: string): boolean {
  if (!opener) return false;
  opener(path);
  return true;
}

/** True while this window has an editor to open files in (a menu builds its items with it). */
export function canOpenFiles(): boolean {
  return opener !== null;
}

/** {@link canOpenFiles} as a hook: true while this window has an editor to open files in. */
export function useCanOpenInEditor(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => opener !== null,
  );
}
