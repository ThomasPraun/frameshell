// Asks the project window to show one sidebar view, from code outside the sidebar (a dialog's "Open Plugins", #756).
import type { SidebarView } from "../../shared/layout.js";

const listeners = new Set<(view: SidebarView) => void>();

/** Show `view` in the project window's sidebar, unfolding the sidebar when it is folded. */
export function showSidebarView(view: SidebarView): void {
  for (const listener of listeners) listener(view);
}

/** Called with each view asked for through {@link showSidebarView}. Returns an unsubscribe function. */
export function onSidebarView(listener: (view: SidebarView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
