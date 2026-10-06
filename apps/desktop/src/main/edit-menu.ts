import type { MenuItemConstructorOptions } from "electron";
import type { HistoryCommand } from "../shared/api.js";

/** Menu item ids of Undo and Redo: e2e tests click them through `Menu.getApplicationMenu()`. */
export const EDIT_MENU_IDS = { undo: "edit-undo", redo: "edit-redo" } as const;

/**
 * The app's Edit menu (#119). Undo and Redo do not use Electron's `undo` and
 * `redo` roles, which only undo text: they hand the command to the focused
 * window (`dispatch`), which undoes text in a text field and the timeline
 * anywhere else. The page sees their keys first: a key it handles (the
 * timeline, Monaco, xterm) never reaches the menu, so nothing runs twice.
 * Clipboard items keep their roles, which make copy and paste work in
 * xterm and Monaco on macOS.
 */
export function editMenu(platform: NodeJS.Platform, dispatch: (command: HistoryCommand) => void): MenuItemConstructorOptions {
  const mac = platform === "darwin";
  return {
    label: "Edit",
    submenu: [
      { id: EDIT_MENU_IDS.undo, label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => dispatch("undo") },
      { id: EDIT_MENU_IDS.redo, label: "Redo", accelerator: mac ? "Shift+CmdOrCtrl+Z" : "Ctrl+Y", click: () => dispatch("redo") },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(mac ? [{ role: "pasteAndMatchStyle" as const }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };
}
