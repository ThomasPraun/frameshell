import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** One menu entry. */
export interface MenuItem {
  label: string;
  /** Shortcut hint shown on the right, e.g. `⌘L`. */
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
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
  /** Show `items` at client coordinates `x`, `y`, replacing any open menu. */
  open(x: number, y: number, items: MenuItem[]): void {
    publish({ x, y, items });
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

/** Renders {@link contextMenu}; mount once. Closes on Escape, a press elsewhere, scroll, resize or blur. */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(contextMenu.subscribe, contextMenu.get);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the window: flip left or up near the edges.
  useLayoutEffect(() => {
    if (!menu || !box.current) return setPlace(null);
    const { width, height } = box.current.getBoundingClientRect();
    setPlace({
      left: menu.x + width > window.innerWidth - 4 ? Math.max(4, menu.x - width) : menu.x,
      top: menu.y + height > window.innerHeight - 4 ? Math.max(4, menu.y - height) : menu.y,
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
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) return null;
  const move = (step: number) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  return (
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
      {menu.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => {
            contextMenu.close();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
