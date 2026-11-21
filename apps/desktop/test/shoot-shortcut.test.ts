import { describe, expect, it } from "vitest";
import { SHOOT_END_ACCELERATOR, createShootShortcut } from "../src/main/shoot-shortcut.js";

function fakeHost(free = true) {
  const keys = new Map<string, () => void>();
  return {
    keys,
    host: {
      register: (accelerator: string, callback: () => void) => {
        if (!free) return false;
        keys.set(accelerator, callback);
        return true;
      },
      unregister: (accelerator: string) => void keys.delete(accelerator),
    },
  };
}

describe("shoot end shortcut", () => {
  it("is held only while a window records, and a press ends the latest one", () => {
    const { keys, host } = fakeHost();
    const shortcut = createShootShortcut(host);
    const ended: string[] = [];
    const a = {};
    const b = {};
    expect(keys.size).toBe(0);
    expect(shortcut.hold(a, () => ended.push("a"))).toBe(true);
    shortcut.hold(b, () => ended.push("b"));
    keys.get(SHOOT_END_ACCELERATOR)!();
    expect(ended).toEqual(["b"]);
    shortcut.release(b);
    keys.get(SHOOT_END_ACCELERATOR)!();
    expect(ended).toEqual(["b", "a"]);
    shortcut.release(a);
    expect(keys.size).toBe(0);
  });

  it("says so when another app owns the keys", () => {
    const shortcut = createShootShortcut(fakeHost(false).host);
    expect(shortcut.hold({}, () => undefined)).toBe(false);
  });
});
