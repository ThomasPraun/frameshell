import { describe, expect, it } from "vitest";
import { restoredTabs } from "../src/renderer/src/terminal-restore.js";

describe("restoredTabs", () => {
  it("brings back one docked tab per terminal still kept, in order, exited ones included", () => {
    const tabs = restoredTabs([
      { id: "a", session: "term-1", shell: "zsh", exitCode: null, agent: "claude" },
      { id: "b", session: "term-2", shell: "zsh", exitCode: 0, agent: null },
    ]);
    expect(tabs).toEqual([
      { key: 0, info: { id: "a", session: "term-1", shell: "zsh" }, exitCode: null, detached: false, name: null },
      { key: 1, info: { id: "b", session: "term-2", shell: "zsh" }, exitCode: 0, detached: false, name: null },
    ]);
    expect(restoredTabs([])).toEqual([]);
  });
});
