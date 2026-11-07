import { describe, expect, it } from "vitest";
import { panelShortcut, shortcutLabel } from "../src/renderer/src/shortcuts.js";

describe("shortcutLabel", () => {
  it("writes Mod as ⌘ and modifiers as symbols on macOS, without separators", () => {
    expect(shortcutLabel("Mod+Shift+T", true)).toBe("⌘⇧T");
    expect(shortcutLabel("Mod+L", true)).toBe("⌘L");
    expect(shortcutLabel("Shift+Delete", true)).toBe("⇧⌫");
    expect(shortcutLabel("Alt+Enter", true)).toBe("⌥↩");
  });

  it("writes Mod as Ctrl and joins keys with + elsewhere", () => {
    expect(shortcutLabel("Mod+Shift+T", false)).toBe("Ctrl+Shift+T");
    expect(shortcutLabel("Mod+L", false)).toBe("Ctrl+L");
    expect(shortcutLabel("Shift+Delete", false)).toBe("Shift+Del");
    expect(shortcutLabel("Delete", false)).toBe("Del");
  });

  it("leaves plain keys as they are", () => {
    expect(shortcutLabel("K", true)).toBe("K");
    expect(shortcutLabel("F2", false)).toBe("F2");
  });
});

describe("panelShortcut", () => {
  it("gives each panel's show/hide key per platform", () => {
    expect(panelShortcut("sidebar", true)).toBe("⌘B");
    expect(panelShortcut("timeline", false)).toBe("Ctrl+J");
    expect(panelShortcut("terminal", false)).toBe("Ctrl+\\");
  });
});
