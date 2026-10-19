import type { DirectorRules } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type DirectedShot, type DirectorTurn, directShots } from "../src/index.js";

// Screen shares in the director (ADR 0016): motion shows the screen, alone or with the speaker's inset.
const ANGLES = [
  { id: "ana", picture: true },
  { id: "ben", picture: true },
  { id: "slides", picture: true, screen: true },
];

const RULES: DirectorRules = {
  minShot: 0,
  maxShot: null,
  cutLead: 0,
  twoShot: { exchange: null, overlap: null },
  wide: { silence: null, laughter: null, together: 3 },
  cutaway: { to: "listener", length: 2 },
  screen: { motion: 2, hold: 1, threshold: 0.3, pip: true, corner: "top-right" },
  weights: {},
};

const turn = (angle: string, start: number, end: number): DirectorTurn => ({ angle, start, end });

function direct(turns: DirectorTurn[], motion: DirectorTurn[], rules: Partial<DirectorRules> = {}, to = 12, angles = ANGLES): DirectedShot[] {
  return directShots({ angles, turns, motion, rules: { ...RULES, ...rules }, from: 0, to });
}

const picture = (shots: DirectedShot[]) => shots.map((shot) => [shot.in, shot.out, shot.shot, shot.angles.join(",")]);

describe("directShots with a screen angle", () => {
  it("shows the screen with the speaker's inset while it moves and someone talks", () => {
    const shots = direct([turn("ana", 0, 6), turn("ben", 6, 12)], [turn("slides", 3, 9)]);
    expect(picture(shots)).toEqual([
      [0, 3, "solo", "ana"],
      [3, 6, "pip", "slides,ana"],
      [6, 9, "pip", "slides,ben"],
      [9, 12, "solo", "ben"],
    ]);
    expect(shots[1]).toMatchObject({ corner: "top-right", reason: "slides moves, ana speaks", confidence: 0.85 });
    expect(shots[0]!.corner).toBeUndefined();
  });

  it("shows the screen alone while nobody speaks", () => {
    const shots = direct([turn("ana", 0, 3), turn("ben", 8, 12)], [turn("slides", 4, 8)]);
    // The 3-8 s silence keeps ana's shot (no wide rule); the screen takes 4-8 s alone, nobody speaks there.
    expect(picture(shots)).toEqual([
      [0, 4, "solo", "ana"],
      [4, 8, "screen", "slides"],
      [8, 12, "solo", "ben"],
    ]);
    expect(shots.find((shot) => shot.shot === "screen")).toMatchObject({ reason: "slides moves", confidence: 0.8 });
  });

  it("never shows a screen as a speaker, whatever its sound says", () => {
    const shots = direct([turn("ana", 0, 6), turn("slides", 6, 12)], []);
    expect(picture(shots)).toEqual([[0, 12, "solo", "ana"]]);
  });

  it("keeps the person shots when the motion is shorter than the rule, and bridges short stills", () => {
    expect(picture(direct([turn("ana", 0, 12)], [turn("slides", 4, 5.5)]))).toEqual([[0, 12, "solo", "ana"]]);
    const bridged = direct([turn("ana", 0, 12)], [turn("slides", 3, 5), turn("slides", 5.5, 8)]);
    expect(picture(bridged)).toEqual([
      [0, 3, "solo", "ana"],
      [3, 8, "pip", "slides,ana"],
      [8, 12, "solo", "ana"],
    ]);
    const split = direct([turn("ana", 0, 12)], [turn("slides", 3, 5), turn("slides", 7, 9)]);
    expect(picture(split)).toEqual([
      [0, 3, "solo", "ana"],
      [3, 5, "pip", "slides,ana"],
      [5, 7, "solo", "ana"],
      [7, 9, "pip", "slides,ana"],
      [9, 12, "solo", "ana"],
    ]);
  });

  it("shows the screen alone when pip is off, and ignores motion when the rule is off", () => {
    const motion = [turn("slides", 3, 9)];
    const turns = [turn("ana", 0, 12)];
    expect(picture(direct(turns, motion, { screen: { ...RULES.screen, pip: false } }))).toEqual([
      [0, 3, "solo", "ana"],
      [3, 9, "screen", "slides"],
      [9, 12, "solo", "ana"],
    ]);
    expect(picture(direct(turns, motion, { screen: { ...RULES.screen, motion: null } }))).toEqual([[0, 12, "solo", "ana"]]);
    expect(picture(directShots({ angles: ANGLES, turns, rules: RULES, from: 0, to: 12 }))).toEqual([[0, 12, "solo", "ana"]]);
  });

  it("picks the person who talks most in the stretch when two people share the shot", () => {
    const shots = direct([turn("ana", 0, 5), turn("ben", 1, 12)], [turn("slides", 2, 10)], { twoShot: { exchange: null, overlap: 0.5 } });
    const pip = shots.filter((shot) => shot.shot === "pip");
    expect(pip.length).toBeGreaterThan(0);
    expect(pip.every((shot) => shot.angles[0] === "slides")).toBe(true);
    expect(pip.at(-1)!.angles).toEqual(["slides", "ben"]);
  });

  it("takes the first moving screen in group order when several move", () => {
    const angles = [...ANGLES, { id: "demo", picture: true, screen: true }];
    const shots = direct([turn("ana", 0, 12)], [turn("demo", 2, 8), turn("slides", 4, 6)], {}, 12, angles);
    expect(picture(shots)).toEqual([
      [0, 2, "solo", "ana"],
      [2, 4, "pip", "demo,ana"],
      [4, 6, "pip", "slides,ana"],
      [6, 8, "pip", "demo,ana"],
      [8, 12, "solo", "ana"],
    ]);
  });

  it("folds pieces shorter than minShot into their neighbour", () => {
    const shots = direct([turn("ana", 0, 12)], [turn("slides", 4, 9)], { minShot: 3 });
    expect(shots.every((shot) => shot.out - shot.in >= 3 - 1e-6)).toBe(true);
    expect(shots[0]!.in).toBe(0);
    expect(shots.at(-1)!.out).toBe(12);
  });

  it("treats a group of screens only as people, and ignores the flag with one person among screens", () => {
    const only = [
      { id: "a", picture: true, screen: true },
      { id: "b", picture: true, screen: true },
    ];
    expect(picture(direct([turn("a", 0, 6), turn("b", 6, 12)], [], {}, 12, only))).toEqual([
      [0, 6, "solo", "a"],
      [6, 12, "solo", "b"],
    ]);
    const shots = direct([turn("ana", 0, 12)], [turn("slides", 4, 8)], {}, 12, [ANGLES[0]!, ANGLES[2]!]);
    expect(picture(shots)).toEqual([
      [0, 4, "solo", "ana"],
      [4, 8, "pip", "slides,ana"],
      [8, 12, "solo", "ana"],
    ]);
  });

  it("is deterministic", () => {
    const turns = [turn("ana", 0, 6), turn("ben", 6, 12)];
    const motion = [turn("slides", 3, 9)];
    expect(direct(turns, motion)).toEqual(direct(turns, motion));
  });
});
