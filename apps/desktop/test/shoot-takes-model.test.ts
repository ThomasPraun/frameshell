import type { ShootStatusResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { type DeviationInfo, currentScene, lineMarks, sceneAfter, takeKey } from "../src/renderer/src/shoot/takes-model.js";

const status = (next: string | null) =>
  ({ scenes: [{ slug: "hook" }, { slug: "problem" }, { slug: "outro" }], next }) as unknown as ShootStatusResult;

const deviation = (kind: DeviationInfo["kind"], words: { from: number; to: number } | null, expected: string, heard: string): DeviationInfo => ({
  id: `d_${kind}`,
  kind,
  scene: "hook",
  line: 5,
  expected,
  heard,
  words,
  at: null,
  maybeTranscription: false,
  accepted: false,
  acceptedBy: null,
});

describe("current scene", () => {
  it("follows the next scene to record until one is picked, and steps to the scene after", () => {
    expect(currentScene(null, null)).toBeNull();
    expect(currentScene(status("problem"), null)).toBe("problem");
    expect(currentScene(status(null), null)).toBe("hook");
    expect(currentScene(status("problem"), "outro")).toBe("outro");
    expect(currentScene(status("problem"), "gone")).toBe("problem");
    expect(sceneAfter(status(null), "hook")).toBe("problem");
    expect(sceneAfter(status(null), "outro")).toBeNull();
  });
});

describe("takeKey", () => {
  const key = (key: string, extra: Partial<KeyboardEvent> = {}) =>
    takeKey({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, target: null, ...extra });
  it("reads T and C, never with modifiers or repeats", () => {
    expect(key("t")).toBe("take");
    expect(key("C")).toBe("cut");
    expect(key("x")).toBeNull();
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("c", { repeat: true })).toBeNull();
  });
  it("still reads them when a select kept focus, but not in a text field", () => {
    const select = { nodeType: 1, tagName: "SELECT", isContentEditable: false } as unknown as EventTarget;
    const input = { nodeType: 1, tagName: "INPUT", type: "text", isContentEditable: false } as unknown as EventTarget;
    expect(key("t", { target: select })).toBe("take");
    expect(key("t", { target: input })).toBeNull();
  });
});

describe("lineMarks", () => {
  const words = ["Hola", "a", "todos", "y", "bienvenidos"];
  it("strikes missing words and inserts what was heard instead or in addition", () => {
    const { marks, notes } = lineMarks(words, [
      deviation("missing", { from: 1, to: 1 }, "a", ""),
      deviation("changed", { from: 4, to: 4 }, "bienvenidos", "bienvenidas"),
      deviation("added", null, "", "eh"),
      deviation("pause", { from: 2, to: 3 }, "", "2.1 s"),
    ]);
    expect(marks.map((mark) => [mark.text, mark.kind])).toEqual([
      ["Hola", "said"],
      ["a", "missing"],
      ["todos", "said"],
      ["y", "said"],
      ["bienvenidos", "missing"],
      ["bienvenidas", "heard"],
      ["eh", "heard"],
    ]);
    expect(notes.map((note) => note.kind)).toEqual(["pause"]);
  });
});
