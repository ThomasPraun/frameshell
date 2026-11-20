// Pieces of the application menu that depend on the running app (#754): the open windows listed in Window, and the
// developer items of View, which a release build leaves out.

/** An open project window as the Window menu lists it. */
export interface ListedWindow {
  /** `webContents.id` of the window. */
  id: number;
  /** Project name, or the window's title when no project is open (the welcome screen). */
  name: string;
  focused: boolean;
}

/**
 * Window menu items switching between the open windows, one radio item each, the focused one checked; empty with a
 * single window. macOS lists windows in its own Window menu, so callers add these elsewhere only.
 */
export function windowListItems(windows: readonly ListedWindow[], focus: (id: number) => void): Electron.MenuItemConstructorOptions[] {
  if (windows.length < 2) return [];
  return [
    { type: "separator" },
    ...windows.map(({ id, name, focused }) => ({
      id: `window-${id}`,
      label: name.replaceAll("&", "&&"),
      type: "radio" as const,
      checked: focused,
      click: () => focus(id),
    })),
  ];
}

/**
 * Whether View offers Reload, Force Reload and Developer Tools: in development builds, or with `FRAMESHELL_DEVTOOLS=1`.
 * A release build leaves them out: Ctrl+R was easy to hit and reloaded the window.
 */
export function showsDevItems(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged || env["FRAMESHELL_DEVTOOLS"] === "1";
}
