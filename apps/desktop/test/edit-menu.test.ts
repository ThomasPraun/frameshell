import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { EDIT_MENU_IDS, editMenu } from "../src/main/edit-menu.js";
import type { HistoryCommand } from "../src/shared/api.js";

// Seam under test: the app's Edit menu template (#119). Undo and Redo reach the window, clipboard roles stay.

const items = (platform: NodeJS.Platform, dispatch: (command: HistoryCommand, focused: unknown) => void = () => undefined) =>
  editMenu(platform, dispatch).submenu as MenuItemConstructorOptions[];

describe("editMenu", () => {
  it("shows Undo and Redo with the platform's keys, and hands them to the window the click reports focused", () => {
    const sent: [HistoryCommand, unknown][] = [];
    const mac = items("darwin", (command, focused) => sent.push([command, focused]));
    const [undo, redo] = mac;
    expect(undo).toMatchObject({ id: EDIT_MENU_IDS.undo, label: "Undo", accelerator: "CmdOrCtrl+Z" });
    expect(redo).toMatchObject({ id: EDIT_MENU_IDS.redo, label: "Redo", accelerator: "Shift+CmdOrCtrl+Z" });
    expect(items("win32")[1]).toMatchObject({ accelerator: "Ctrl+Y" });
    const panelWindow = { id: 4 };
    (undo!.click as (item: unknown, focused?: unknown) => void)({}, panelWindow);
    (redo!.click as (item: unknown, focused?: unknown) => void)({});
    expect(sent).toEqual([
      ["undo", panelWindow],
      ["redo", undefined],
    ]);
  });

  it("keeps the clipboard roles xterm and Monaco need, and never the text-only undo roles", () => {
    const roles = items("darwin").map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(["cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]);
    expect(items("linux").map((item) => item.role)).not.toContain("undo");
  });
});
