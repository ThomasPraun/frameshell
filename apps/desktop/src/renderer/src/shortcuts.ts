import type { PanelId } from "../../shared/layout.js";

/** Whether the app runs on macOS: shortcuts there use ⌘ where other platforms use Ctrl. */
export const isMac = navigator.userAgent.includes("Mac");

const MAC_KEYS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Backspace: "⌫", Delete: "⌫", Enter: "↩" };
const OTHER_KEYS: Record<string, string> = { Mod: "Ctrl", Backspace: "Del", Delete: "Del" };

/**
 * A shortcut as menus and tooltips show it on this platform: `keys` joins key
 * names with `+`, `Mod` standing for ⌘ on macOS and Ctrl elsewhere, so
 * `Mod+Shift+T` reads `⌘⇧T` on macOS and `Ctrl+Shift+T` elsewhere.
 */
export function shortcutLabel(keys: string, mac = isMac): string {
  const names = mac ? MAC_KEYS : OTHER_KEYS;
  return keys
    .split("+")
    .map((key) => names[key] ?? key)
    .join(mac ? "" : "+");
}

/** Key that, with Mod, shows or hides each panel of the project window. */
export const PANEL_KEYS: Record<PanelId, string> = { sidebar: "b", timeline: "j", terminal: "\\" };

/** The show/hide shortcut of `panel` as tooltips show it, such as `⌘B`. */
export function panelShortcut(panel: PanelId, mac = isMac): string {
  return shortcutLabel(`Mod+${PANEL_KEYS[panel].toUpperCase()}`, mac);
}
