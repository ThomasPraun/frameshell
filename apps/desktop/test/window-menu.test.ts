import { describe, expect, it } from "vitest";
import { showsDevItems, windowListItems } from "../src/main/window-menu.js";

describe("window menu", () => {
  it("lists the open windows to switch to, the focused one checked, none with a single window", () => {
    const focused: number[] = [];
    expect(windowListItems([{ id: 1, name: "Demo", focused: true }], (id) => focused.push(id))).toEqual([]);
    const items = windowListItems(
      [
        { id: 1, name: "Demo", focused: true },
        { id: 4, name: "Rock & Roll", focused: false },
      ],
      (id) => focused.push(id),
    );
    expect(items.map(({ type, label, checked }) => ({ type, label, checked }))).toEqual([
      { type: "separator", label: undefined, checked: undefined },
      { type: "radio", label: "Demo", checked: true },
      { type: "radio", label: "Rock && Roll", checked: false },
    ]);
    (items[2]!.click as () => void)();
    expect(focused).toEqual([4]);
  });

  it("offers Reload and Developer Tools in development builds or on request only", () => {
    expect(showsDevItems(false, {})).toBe(true);
    expect(showsDevItems(true, {})).toBe(false);
    expect(showsDevItems(true, { FRAMESHELL_DEVTOOLS: "1" })).toBe(true);
  });
});
