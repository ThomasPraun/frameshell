import { describe, expect, it } from "vitest";
import { liveWord, shouldWake } from "../src/renderer/src/shoot/live-state.js";
import type { LiveStatus } from "../src/shared/api.js";

const status = (state: LiveStatus["state"]): LiveStatus => ({ state, model: null, detail: null, progress: null });

describe("live recognition state words", () => {
  it("names each state for the person", () => {
    expect(liveWord(status("ready"))).toBe("listening");
    expect(liveWord(status("installing"))).toBe("starting");
    expect(liveWord(status("warming"))).toBe("starting");
    expect(liveWord(status("off"))).toBe("off");
    expect(liveWord(status("download"))).toBe("missing");
    expect(liveWord(status("unavailable"))).toBe("unavailable");
  });

  it("wakes the recognizer only when following and it is off, never to download", () => {
    expect(shouldWake(status("off"), true)).toBe(true);
    expect(shouldWake(status("off"), false)).toBe(false);
    for (const state of ["download", "installing", "warming", "ready", "unavailable"] as const) expect(shouldWake(status(state), true)).toBe(false);
  });
});
