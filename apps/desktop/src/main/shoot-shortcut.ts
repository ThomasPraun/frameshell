// A global shortcut that ends the shoot (#744): while a session records, Frameshell's windows are hidden from screen
// captures, so remote help cannot see or click End, and the person may be in a call app. The shortcut works from any
// app, and only while a session records: it is registered at Start and released at End.

import { SHOOT_END_KEYS } from "../shared/api.js";

/** {@link SHOOT_END_KEYS} as Electron's `globalShortcut` names it. */
export const SHOOT_END_ACCELERATOR = SHOOT_END_KEYS.replace("Mod", "CommandOrControl");

/** The parts of Electron's `globalShortcut` the holder uses. */
export interface ShortcutHost {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Holds {@link SHOOT_END_ACCELERATOR} while at least one window records. A press ends the session of the window that
 * started recording last. Registering can fail (another app owns the keys); `hold` then returns false and the End
 * button stays the way to stop.
 */
export function createShootShortcut(host: ShortcutHost) {
  /** Recording windows, oldest first, each with what a press does there. */
  const holders: { owner: object; end: () => void }[] = [];
  let registered = false;
  return {
    /** `owner` records: a press calls `end`. Returns whether the shortcut is registered. */
    hold(owner: object, end: () => void): boolean {
      const index = holders.findIndex((holder) => holder.owner === owner);
      if (index !== -1) holders.splice(index, 1);
      holders.push({ owner, end });
      if (!registered) registered = host.register(SHOOT_END_ACCELERATOR, () => holders.at(-1)?.end());
      return registered;
    },
    /** `owner` stopped recording; the shortcut goes with the last holder. */
    release(owner: object): void {
      const index = holders.findIndex((holder) => holder.owner === owner);
      if (index !== -1) holders.splice(index, 1);
      if (holders.length === 0 && registered) {
        host.unregister(SHOOT_END_ACCELERATOR);
        registered = false;
      }
    },
  };
}
