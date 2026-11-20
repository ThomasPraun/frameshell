// Ctrl+V in the app's terminals on Windows and Linux (#743): the browser pastes, not the program's ^V.

/** How long after Ctrl+V the browser's paste event may come; none by then means nothing to paste. */
const PASTE_WAIT_MS = 120;

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
 * Ctrl+V through to the browser, whose paste event xterm turns into a (bracketed) paste of the text. When the paste
 * carries no text (an image, as Claude Code takes them), or the browser fires none (an empty clipboard), `sendCtrlV`
 * gives the program the ^V it would have had. Returns the handler and the remover.
 */
export function terminalPaste(
  element: HTMLElement,
  sendCtrlV: () => void,
  view: Pick<Window, "setTimeout" | "clearTimeout"> = window,
): { keyHandler: (event: KeyboardEvent) => boolean; dispose: () => void } {
  let waiting: number | undefined;
  const settle = () => {
    view.clearTimeout(waiting);
    waiting = undefined;
  };
  const onPaste = (event: ClipboardEvent) => {
    if (event.clipboardData?.getData("text/plain")) {
      settle();
      return;
    }
    // Nothing to paste as text: xterm would send an empty bracketed paste. The program gets one ^V instead.
    event.stopPropagation();
    event.preventDefault();
    if (waiting === undefined) return;
    settle();
    sendCtrlV();
  };
  element.addEventListener("paste", onPaste, true);
  return {
    keyHandler(event) {
      if (!isPasteKey(event)) return true;
      settle();
      waiting = view.setTimeout(() => {
        waiting = undefined;
        sendCtrlV();
      }, PASTE_WAIT_MS);
      return false;
    },
    dispose() {
      settle();
      element.removeEventListener("paste", onPaste, true);
    },
  };
}
