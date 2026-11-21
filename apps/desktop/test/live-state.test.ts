import { describe, expect, it } from "vitest";
import { liveWord, shouldListen, shouldWake } from "../src/renderer/src/shoot/live-state.js";
import type { LiveStatus } from "../src/shared/api.js";

const status = (state: LiveStatus["state"]): LiveStatus => ({ state, model: null, detail: null, progress: null });

describe("live recognition state words", () => {
  it("names each state for the person", () => {
    expect(liveWord(status("ready"), true)).toBe("listening");
    expect(liveWord(status("installing"), true)).toBe("starting");
    expect(liveWord(status("warming"), true)).toBe("starting");
    expect(liveWord(status("off"), true)).toBe("off");
    expect(liveWord(status("download"), true)).toBe("missing");
    expect(liveWord(status("unavailable"), true)).toBe("unavailable");
  });

  it("listens only while a shoot records: ready before Start and after End leaves the microphone alone", () => {
    expect(liveWord(status("ready"), false)).toBe("ready");
    expect(shouldListen(status("ready"), true)).toBe(true);
    expect(shouldListen(status("ready"), false)).toBe(false);
    expect(shouldListen(status("warming"), true)).toBe(false);
  });

  it("wakes the recognizer only when following and it is off, never to download", () => {
    expect(shouldWake(status("off"), true)).toBe(true);
    expect(shouldWake(status("off"), false)).toBe(false);
    for (const state of ["download", "installing", "warming", "ready", "unavailable"] as const) expect(shouldWake(status(state), true)).toBe(false);
  });
});
