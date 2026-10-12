// Windows of the project (ADR 0012): the project window and its detached panel windows, all drawn by this one
// renderer. Panel code takes timing, observers, focus and events from the window its elements live in, never the
// global `window`; and elements of a panel window come from that window's realm, so no `instanceof HTMLElement`.

type WindowListener = (view: Window) => void;

const panelWindows = new Set<Window>();
const added = new Set<WindowListener>();

/** Every window the project's panels are drawn in: the project window first, then the detached panels' windows. */
export function projectWindows(): Window[] {
  return [window, ...panelWindows];
}

/** Count `view` (a detached panel's window) among the project's windows until the returned function runs. */
export function addProjectWindow(view: Window): () => void {
  panelWindows.add(view);
  for (const listener of [...added]) listener(view);
  return () => {
    panelWindows.delete(view);
  };
}

/**
 * Listen for `type` on every project window, those open now and those
 * opened later, until the returned function runs. Global keys use it, so
 * they work from a detached panel's window as from the project window.
 */
export function listenEverywhere<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  capture = false,
): () => void {
  const views = new Set<Window>();
  const attach = (view: Window) => {
    if (views.has(view)) return;
    views.add(view);
    view.addEventListener(type, listener, capture);
  };
  for (const view of projectWindows()) attach(view);
  added.add(attach);
  return () => {
    added.delete(attach);
    for (const view of views) view.removeEventListener(type, listener, capture);
    views.clear();
  };
}

/** The window `target` (a node, or a window) belongs to; the project window when it cannot tell. */
export function windowOf(target: EventTarget | null | undefined): Window {
  if (!target) return window;
  if ((target as Window).window === target) return target as Window;
  return (target as Node).ownerDocument?.defaultView ?? window;
}

/** The project window that has the keyboard focus; the project window when none has. */
export function focusedWindow(): Window {
  return projectWindows().find((view) => !view.closed && view.document.hasFocus()) ?? window;
}

/** `target` as an element of any project window, else null. */
export function elementOf(target: EventTarget | null | undefined): HTMLElement | null {
  return target && (target as Node).nodeType === 1 ? (target as HTMLElement) : null;
}

/** Whether `target` is an element of any project window with tag `tag` (upper case, as `tagName` has it). */
export function isTag(target: EventTarget | null | undefined, tag: string): boolean {
  return elementOf(target)?.tagName === tag;
}
