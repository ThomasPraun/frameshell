// A detached panel's window (ADR 0012): a blank window this renderer opens and draws the panel into through a React
// portal, so the panel keeps sharing the playhead, the selection and every other store with the project window.
import { useEffect, useRef, useState } from "react";
import { type DetachablePanel, PANEL_WINDOW_PREFIX } from "../../shared/layout.js";
import { addProjectWindow } from "./windows.js";

let opened = 0;

/**
 * Open `panel`'s window while `panel` is non-null and return the element to
 * portal the panel into; null while closed. Main places the window where it
 * was. The window gets the project window's stylesheets (kept in step, so a
 * development style reload reaches it too) and `title`. `onClosed` runs when
 * the user closes the window, not when this hook closes it.
 */
export function usePanelWindow(panel: DetachablePanel | null, title: string, onClosed: () => void): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;

  useEffect(() => {
    if (!panel) return;
    // A name per open: a window still closing (a quick dock and detach, development's double effects) is never reused.
    const child = window.open("about:blank", `${PANEL_WINDOW_PREFIX}${panel}/${++opened}`);
    if (!child) {
      closed.current();
      return;
    }
    const doc = child.document;
    const copyStyles = () => {
      for (const node of doc.head.querySelectorAll("[data-copied-style]")) node.remove();
      for (const node of document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')) {
        const copy = node.cloneNode(true) as HTMLElement;
        // Absolute: the blank document's own URL resolves nothing.
        if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
        copy.setAttribute("data-copied-style", "");
        doc.head.append(copy);
      }
    };
    copyStyles();
    const styles = new MutationObserver(copyStyles);
    styles.observe(document.head, { childList: true, subtree: true, characterData: true });
    for (const { name, value } of document.documentElement.attributes) doc.documentElement.setAttribute(name, value);
    doc.body.className = document.body.className;
    const root = doc.createElement("div");
    root.className = "panel-window";
    root.setAttribute("data-testid", `panel-window-${panel}`);
    doc.body.append(root);
    const removeWindow = addProjectWindow(child);
    let closing = false;
    child.addEventListener("pagehide", () => {
      removeWindow();
      if (!closing) closed.current();
    });
    setHost(root);
    return () => {
      closing = true;
      styles.disconnect();
      removeWindow();
      setHost(null);
      child.close();
    };
  }, [panel]);

  useEffect(() => {
    if (host) host.ownerDocument.title = title;
  }, [host, title]);

  return host;
}
