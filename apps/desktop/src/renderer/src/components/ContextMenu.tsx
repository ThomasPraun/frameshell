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
  /** What choosing it does; ignored when it has {@link MenuItem.items}. */
  run?: () => void;
  /** Entries of a submenu it opens on hover, click or →, instead of running. */
  items?: MenuItem[];
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
  /** Label of the item whose submenu shows, and whether it opened from the keyboard (its first entry takes focus). */
  const [sub, setSub] = useState<{ label: string; focus: boolean } | null>(null);
  /** The submenu shows left of its item: right of it, it would leave the window. */
  const [subLeft, setSubLeft] = useState(false);
  useLayoutEffect(() => setSub(null), [menu]);
  useLayoutEffect(() => {
    const flyout = box.current?.querySelector<HTMLElement>(".context-submenu");
    if (!menu || !sub || !flyout) return setSubLeft(false);
    const parent = flyout.parentElement!.getBoundingClientRect();
    setSubLeft(parent.right + flyout.getBoundingClientRect().width > menu.view.innerWidth - 4);
    if (sub.focus) flyout.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu, sub]);

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
  const focused = () => menu.view.document.activeElement as HTMLButtonElement | null;
  /** Entries of the menu (or submenu) holding the focus, in order. */
  const siblings = (): HTMLButtonElement[] => {
    const list = focused()?.closest<HTMLElement>("[role=menu]") ?? box.current;
    return [...(list?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled), :scope > .context-menu-parent > button:not(:disabled)") ?? [])];
  };
  const move = (step: number) => {
    const buttons = siblings();
    const at = buttons.indexOf(focused()!);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  const entries = (items: readonly MenuItem[], nested: boolean) =>
    items.flatMap((item, index) => {
      const line = item.separated && index > 0 ? [<div key={`${item.label}-line`} role="separator" className="context-menu-separator" />] : [];
      if (item.items && !nested) {
        const open = sub?.label === item.label;
        return [
          ...line,
          <div key={item.label} className="context-menu-parent" data-label={item.label} onPointerEnter={() => !item.disabled && setSub({ label: item.label, focus: false })}>
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              className={`context-menu-item${open ? " is-open" : ""}`}
              disabled={item.disabled}
              onClick={() => setSub({ label: item.label, focus: true })}
            >
              <span>{item.label}</span>
              <span className="context-menu-chevron" aria-hidden="true">
                {item.shortcut && <kbd>{item.shortcut}</kbd>}›
              </span>
            </button>
            {open && (
              <div className={`context-menu context-submenu${subLeft ? " is-left" : ""}`} role="menu" aria-label={item.label}>
                {entries(item.items, true)}
              </div>
            )}
          </div>,
        ];
      }
      return [
        ...line,
        <button
          key={item.label}
          role="menuitem"
          className={`context-menu-item${item.danger ? " is-danger" : ""}`}
          disabled={item.disabled}
          onPointerEnter={nested ? undefined : () => setSub(null)}
          onClick={() => {
            contextMenu.close();
            item.run?.();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>,
      ];
    });
  const element = (
    <div
      ref={box}
      className="context-menu"
      role="menu"
      style={{ left: place?.left ?? menu.x, top: place?.top ?? menu.y, visibility: place ? "visible" : "hidden" }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const parent = focused()?.closest<HTMLElement>(".context-menu-parent");
        const inSubmenu = !!focused()?.closest(".context-submenu");
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else if (event.key === "ArrowRight" && parent && !inSubmenu) setSub({ label: parent.dataset["label"]!, focus: true });
        else if (event.key === "ArrowLeft" && parent && inSubmenu) {
          setSub(null);
          parent.querySelector<HTMLButtonElement>(":scope > button")?.focus();
        } else return;
        event.preventDefault();
      }}
    >
      {entries(menu.items, false)}
    </div>
  );
  return menu.view === window ? element : createPortal(element, menu.view.document.body);
}
