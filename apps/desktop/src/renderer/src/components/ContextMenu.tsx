import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/** One menu entry. */
export interface MenuItem {
  label: string;
  /** Shortcut hint shown on the right, e.g. `⌘L`. */
  shortcut?: string;
  disabled?: boolean;
  /** Starts a new group: a line is drawn above it. */
  separated?: boolean;
  /** Destroys or removes something: drawn in the danger color. */
  danger?: boolean;
  run: () => void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  /** Window the menu shows in: the project window, or a detached panel's (ADR 0012). */
  view: Window;
}

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();
const publish = (next: OpenMenu | null) => {
  current = next;
  for (const listener of listeners) listener();
};

/**
 * The app's one context menu, drawn in the page (not a native menu) so it
 * matches the app and tests can click it. Panels open it from `contextmenu`.
 */
export const contextMenu = {
  /** Show `items` at client coordinates `x`, `y` of window `view`, replacing any open menu. */
  open(x: number, y: number, items: MenuItem[], view: Window = window): void {
    publish({ x, y, items, view });
  },
  close(): void {
    if (current) publish(null);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): OpenMenu | null => current,
};

/**
 * Renders {@link contextMenu}; mount once, in the project window. A menu of
 * a detached panel's window is drawn there, through a portal. Closes on
 * Escape, a press elsewhere, scroll, resize or blur.
 */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(contextMenu.subscribe, contextMenu.get);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the window: flip left or up near the edges.
  useLayoutEffect(() => {
    if (!menu || !box.current) return setPlace(null);
    const { width, height } = box.current.getBoundingClientRect();
    const { innerWidth, innerHeight } = menu.view;
    setPlace({
      left: menu.x + width > innerWidth - 4 ? Math.max(4, menu.x - width) : menu.x,
      top: menu.y + height > innerHeight - 4 ? Math.max(4, menu.y - height) : menu.y,
    });
    box.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => contextMenu.close();
    const onPress = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const { view } = menu;
    view.addEventListener("pointerdown", onPress, true);
    view.addEventListener("keydown", onKey, true);
    view.addEventListener("wheel", close, true);
    view.addEventListener("resize", close);
    view.addEventListener("blur", close);
    // Its window closed (a detached panel docked back): nothing is left to click.
    view.addEventListener("pagehide", close);
    return () => {
      view.removeEventListener("pointerdown", onPress, true);
      view.removeEventListener("keydown", onKey, true);
      view.removeEventListener("wheel", close, true);
      view.removeEventListener("resize", close);
      view.removeEventListener("blur", close);
      view.removeEventListener("pagehide", close);
    };
  }, [menu]);

  if (!menu) return null;
  const move = (step: number) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(menu.view.document.activeElement as HTMLButtonElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  const element = (
    <div
      ref={box}
      className="context-menu"
      role="menu"
      style={{ left: place?.left ?? menu.x, top: place?.top ?? menu.y, visibility: place ? "visible" : "hidden" }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else return;
        event.preventDefault();
      }}
    >
      {menu.items.flatMap((item, index) => [
        ...(item.separated && index > 0 ? [<div key={`${item.label}-line`} role="separator" className="context-menu-separator" />] : []),
        <button
          key={item.label}
          role="menuitem"
          className={`context-menu-item${item.danger ? " is-danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            contextMenu.close();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>,
      ])}
    </div>
  );
  return menu.view === window ? element : createPortal(element, menu.view.document.body);
}
