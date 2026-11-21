// Ctrl+V in the app's terminals on Windows and Linux (#743): the browser pastes, not the program's ^V.

/** The key event is a plain Ctrl+V (no Shift, Alt or Meta) going down: the terminal leaves it to the browser's paste. */
export function isPasteKey(event: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "v" || event.key === "V" || event.code === "KeyV")
  );
}

/**
 * Ctrl+V for a terminal shown in `element`. `keyHandler` goes to xterm's `attachCustomKeyEventHandler`: it lets a plain
 * Ctrl+V through to the browser, whose paste event xterm turns into a (bracketed) paste of the text. What the clipboard
 * holds decides, never a timer: with no text on it (an image, as Claude Code takes them, or nothing) `sendCtrlV` gives
 * the program the ^V it would have had, and the browser's empty paste, if any, is dropped. Returns the handler and the
 * remover.
 */
export function terminalPaste(
  element: HTMLElement,
  sendCtrlV: () => void,
  clipboardHasText: () => Promise<boolean>,
): { keyHandler: (event: KeyboardEvent) => boolean; dispose: () => void } {
  const onPaste = (event: ClipboardEvent) => {
    if (event.clipboardData?.getData("text/plain")) return;
    // Nothing to paste as text: xterm would send an empty bracketed paste. The key handler sends the ^V.
    event.stopPropagation();
    event.preventDefault();
  };
  element.addEventListener("paste", onPaste, true);
  return {
    keyHandler(event) {
      if (!isPasteKey(event)) return true;
      void clipboardHasText().then(
        (text) => {
          if (!text) sendCtrlV();
        },
        () => sendCtrlV(),
      );
      return false;
    },
    dispose() {
      element.removeEventListener("paste", onPaste, true);
    },
  };
}
