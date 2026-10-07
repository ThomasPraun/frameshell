import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { EDIT_MENU_IDS, editMenu } from "../src/main/edit-menu.js";
import type { HistoryCommand } from "../src/shared/api.js";

// Seam under test: the app's Edit menu template (#119). Undo and Redo reach the window, clipboard roles stay.

const items = (platform: NodeJS.Platform, dispatch: (command: HistoryCommand) => void = () => undefined) =>
  editMenu(platform, dispatch).submenu as MenuItemConstructorOptions[];

describe("editMenu", () => {
  it("shows Undo and Redo with the platform's keys, and hands them to the window", () => {
    const sent: HistoryCommand[] = [];
    const mac = items("darwin", (command) => sent.push(command));
    const [undo, redo] = mac;
    expect(undo).toMatchObject({ id: EDIT_MENU_IDS.undo, label: "Undo", accelerator: "CmdOrCtrl+Z" });
    expect(redo).toMatchObject({ id: EDIT_MENU_IDS.redo, label: "Redo", accelerator: "Shift+CmdOrCtrl+Z" });
    expect(items("win32")[1]).toMatchObject({ accelerator: "Ctrl+Y" });
    (undo!.click as () => void)();
    (redo!.click as () => void)();
    expect(sent).toEqual(["undo", "redo"]);
  });

  it("keeps the clipboard roles xterm and Monaco need, and never the text-only undo roles", () => {
    const roles = items("darwin").map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(["cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]);
    expect(items("linux").map((item) => item.role)).not.toContain("undo");
  });
});
