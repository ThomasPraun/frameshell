import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { elementOf } from "../windows.js";

/**
 * Keys and focus of a modal dialog `box` drawn in `view`, the window it shows in (ADR 0012): it takes the focus when it
 * opens, Escape calls `onEscape`, keys outside it do nothing and focus that leaves it comes back. Listens on the window in
 * the capture phase, not on the dialog: a button disabled while working drops the focus to the page, and the timeline's
 * and preview's keys must not act then. Returns the box's own keydown handler: inside, a key does its own work (typing,
 * a button), never a global one, and Tab wraps around the dialog's buttons and fields.
 */
export function useModal(box: RefObject<HTMLDivElement | null>, view: Window, onEscape: () => void): (event: ReactKeyboardEvent<HTMLDivElement>) => void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => box.current?.focus(), [box]);
  useEffect(() => {
    const inside = (target: EventTarget | null) => {
      const element = elementOf(target);
      return element !== null && (box.current?.contains(element) ?? false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escape.current();
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !inside(event.target)) event.stopPropagation();
    };
    const onFocus = (event: FocusEvent) => {
      if (!inside(event.target)) box.current?.focus();
    };
    view.addEventListener("keydown", onKey, true);
    view.document.addEventListener("focusin", onFocus);
    return () => {
      view.removeEventListener("keydown", onKey, true);
      view.document.removeEventListener("focusin", onFocus);
    };
  }, [box, view]);
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.nativeEvent.stopPropagation();
    if (event.key !== "Tab" || !box.current) return;
    const stops = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = box.current.ownerDocument.activeElement;
    const wrapTo = !first || !last ? null : event.shiftKey && (active === first || active === box.current) ? last : !event.shiftKey && active === last ? first : undefined;
    if (wrapTo === undefined) return;
    event.preventDefault();
    wrapTo?.focus();
  };
}
