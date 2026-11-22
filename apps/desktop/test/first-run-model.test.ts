import { describe, expect, it } from "vitest";
import {
  filePaths,
  firstRunState,
  isAgentAuthor,
  isPersonAuthor,
} from "../src/renderer/src/first-run/model.js";

// Seam under test: which of the four first-run steps (#787) a project's state ticks.

const facts = (fields: Partial<Parameters<typeof firstRunState>[0]> = {}) => ({
  aiConnected: false,
  clips: 0,
  authors: [],
  files: [],
  ...fields,
});
const done = (state: ReturnType<typeof firstRunState>) =>
  state.steps.filter((each) => each.done).map((each) => each.step);

describe("firstRunState", () => {
  it("lists the four steps in order, none done in a new project", () => {
    const state = firstRunState(facts());
    expect(state.steps.map((each) => each.step)).toEqual([
      "connect",
      "footage",
      "cut",
      "export",
    ]);
    expect(state.done).toBe(0);
  });

  it("ticks connect from a connected app, or from an agent's change when no settings say so", () => {
    expect(done(firstRunState(facts({ aiConnected: true })))).toEqual([
      "connect",
    ]);
    expect(
      done(firstRunState(facts({ authors: ["agent:claude:s1"] }))),
    ).toEqual(["connect"]);
  });

  it("ticks footage once the timeline holds a clip", () => {
    expect(done(firstRunState(facts({ clips: 2 })))).toEqual(["footage"]);
  });

  it("ticks the cut only with both an agent's change and the person's", () => {
    expect(done(firstRunState(facts({ authors: ["ui"] })))).toEqual([]);
    expect(done(firstRunState(facts({ authors: ["cli:s2", "ui"] })))).toEqual([
      "connect",
      "cut",
    ]);
    expect(
      done(firstRunState(facts({ authors: ["agent:codex:s1", "file"] }))),
    ).toContain("cut");
  });

  it("ticks export only for a video under exports/", () => {
    expect(
      done(
        firstRunState(
          facts({ files: ["exports/notes.txt", "assets/take.mp4"] }),
        ),
      ),
    ).toEqual([]);
    expect(
      done(firstRunState(facts({ files: ["exports/launch.MP4"] }))),
    ).toEqual(["export"]);
  });

  it("counts what is done", () => {
    expect(
      firstRunState(
        facts({
          aiConnected: true,
          clips: 1,
          authors: ["cli", "ui"],
          files: ["exports/a.mov"],
        }),
      ).done,
    ).toBe(4);
  });
});

describe("authors", () => {
  it("tells agents and terminal commands from the person", () => {
    expect(["cli", "cli:s1", "agent:claude:s1"].every(isAgentAuthor)).toBe(
      true,
    );
    expect(["ui", "file", "plugin:hyperframes"].some(isAgentAuthor)).toBe(
      false,
    );
    expect(["ui", "file"].every(isPersonAuthor)).toBe(true);
    expect(isPersonAuthor("plugin:hyperframes")).toBe(false);
  });
});

describe("filePaths", () => {
  it("flattens the explorer tree", () => {
    expect(
      filePaths([
        { kind: "file", name: "frameshell.json", path: "frameshell.json" },
        {
          kind: "dir",
          name: "exports",
          path: "exports",
          children: [{ kind: "file", name: "a.mp4", path: "exports/a.mp4" }],
        },
      ]),
    ).toEqual(["frameshell.json", "exports/a.mp4"]);
  });
});
