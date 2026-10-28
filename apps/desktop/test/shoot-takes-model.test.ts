import type { ShootStatusResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import {
  type CutTake,
  type DeviationInfo,
  currentScene,
  cutOutcome,
  lineMarks,
  nextTakeNumber,
  sceneAfter,
  sceneTitle,
  takeKey,
} from "../src/renderer/src/shoot/takes-model.js";

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

describe("take feedback", () => {
  type Take = ShootStatusResult["takes"][number];
  const take = (id: string, scene: string, extra: Partial<Take> = {}) =>
    ({ id, scene, discarded: false, state: "analyzed", problem: null, deviations: [], ...extra }) as unknown as Take;
  const withTakes = (takes: Take[]) => ({ scenes: [{ slug: "hook", title: "Hook" }], takes, next: "hook" }) as unknown as ShootStatusResult;
  const cut = (extra: Partial<CutTake> = {}): CutTake => ({ id: "t2", session: "s", scene: "hook", number: 2, short: false, error: null, ...extra });

  it("numbers a scene's takes, counting a cut on its way and leaving out discarded and short ones", () => {
    const status = withTakes([take("t1", "hook"), take("t0", "hook", { discarded: true }), take("t9", "problem")]);
    expect(nextTakeNumber(null, "hook", null)).toBe(1);
    expect(nextTakeNumber(status, "hook", null)).toBe(2);
    expect(nextTakeNumber(status, "hook", cut({ id: null }))).toBe(3);
    expect(nextTakeNumber(status, "hook", cut({ short: true }))).toBe(2);
    expect(nextTakeNumber(status, "problem", cut())).toBe(2);
  });

  it("reads the cut take's outcome from the status", () => {
    expect(cutOutcome(withTakes([]), cut({ id: null }))).toEqual({ kind: "analyzing" });
    expect(cutOutcome(withTakes([]), cut())).toEqual({ kind: "analyzing" });
    expect(cutOutcome(withTakes([take("t2", "hook", { state: "transcribing" })]), cut())).toEqual({ kind: "analyzing" });
    expect(cutOutcome(withTakes([take("t2", "hook")]), cut())).toEqual({ kind: "analyzed", differences: 0 });
    const missing = deviation("missing", null, "a", "");
    expect(cutOutcome(withTakes([take("t2", "hook", { deviations: [missing] })]), cut())).toEqual({ kind: "analyzed", differences: 1 });
    const failed = take("t2", "hook", { state: "no-transcript", problem: "ffmpeg failed" });
    expect(cutOutcome(withTakes([failed]), cut())).toEqual({ kind: "failed", problem: "ffmpeg failed" });
    expect(cutOutcome(withTakes([]), cut({ id: null, error: "daemon gone" }))).toEqual({ kind: "failed", problem: "daemon gone" });
    expect(cutOutcome(withTakes([]), cut({ id: null, short: true }))).toEqual({ kind: "short" });
    expect(sceneTitle(withTakes([]), "hook")).toBe("Hook");
    expect(sceneTitle(null, "hook")).toBe("hook");
  });
});
