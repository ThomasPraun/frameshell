import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { HistoryCommand } from "../shared/api.js";
import { type Dict, strings } from "../shared/i18n/index.js";

/** Menu item ids of Undo and Redo: e2e tests click them through `Menu.getApplicationMenu()`. */
export const EDIT_MENU_IDS = { undo: "edit-undo", redo: "edit-redo" } as const;

/**
 * The app's Edit menu (#119). Undo and Redo do not use Electron's `undo` and
 * `redo` roles, which only undo text: they hand the command to the focused
 * window (`dispatch`, with the window Electron reports focused, if any), which undoes text in a text field and the timeline
 * anywhere else. The page sees their keys first: a key it handles (the
 * timeline, Monaco, xterm) never reaches the menu, so nothing runs twice.
 * Clipboard items keep their roles, which make copy and paste work in
 * xterm and Monaco on macOS. `text` words it in the UI language.
 */
export function editMenu(
  platform: NodeJS.Platform,
  dispatch: (command: HistoryCommand, focused: BaseWindow | undefined) => void,
  text: Dict["app"]["menu"] = strings("en").app.menu,
): MenuItemConstructorOptions {
  const mac = platform === "darwin";
  return {
    label: text.edit,
    submenu: [
      { id: EDIT_MENU_IDS.undo, label: text.undo, accelerator: "CmdOrCtrl+Z", click: (_item, focused) => dispatch("undo", focused) },
      {
        id: EDIT_MENU_IDS.redo,
        label: text.redo,
        accelerator: mac ? "Shift+CmdOrCtrl+Z" : "Ctrl+Y",
        click: (_item, focused) => dispatch("redo", focused),
      },
      { type: "separator" },
      { role: "cut", label: text.cut },
      { role: "copy", label: text.copy },
      { role: "paste", label: text.paste },
      ...(mac ? [{ role: "pasteAndMatchStyle" as const, label: text.pasteAndMatchStyle }] : []),
      { role: "delete", label: text.delete },
      { type: "separator" },
      { role: "selectAll", label: text.selectAll },
    ],
  };
}
