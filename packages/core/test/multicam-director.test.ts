import { DIRECTOR_TEMPLATES, DIRECTOR_TEMPLATE_IDS, type DirectorRules } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type DirectedShot, type DirectorTurn, directShots } from "../src/index.js";

const ANGLES = [
  { id: "ana", picture: true },
  { id: "ben", picture: true },
  { id: "cleo", picture: true },
];

/** Every rule off, so each test switches on the one it checks. */
const OFF: DirectorRules = {
  minShot: 0,
  maxShot: null,
  cutLead: 0,
  twoShot: { exchange: null, overlap: null },
  wide: { silence: null, laughter: null, together: 3 },
  cutaway: { to: "listener", length: 2 },
  screen: { motion: null, hold: 0, threshold: 0.3, pip: true, corner: "bottom-right" },
  weights: {},
};

const turn = (angle: string, start: number, end: number): DirectorTurn => ({ angle, start, end });

function direct(turns: DirectorTurn[], rules: Partial<DirectorRules>, to = 10, angles = ANGLES): DirectedShot[] {
  return directShots({ angles, turns, rules: { ...OFF, ...rules }, from: 0, to });
}

/** `[in, out, layout, angles]` per shot. */
const picture = (shots: DirectedShot[]) => shots.map((shot) => [shot.in, shot.out, shot.shot, shot.angles.join(",")]);

describe("directShots", () => {
  it("cuts to whoever speaks, covering the span without gaps", () => {
    const shots = direct([turn("ana", 0, 5), turn("ben", 5, 10)], {});
    expect(picture(shots)).toEqual([
      [0, 5, "solo", "ana"],
      [5, 10, "solo", "ben"],
    ]);
    expect(shots.map((shot) => [shot.confidence, shot.reason])).toEqual([
      [0.95, "ana speaks"],
      [0.95, "ben speaks"],
    ]);
  });

  it("goes wide on a long silence and holds the shot through a short one", () => {
    const turns = [turn("ana", 0, 4), turn("ben", 5, 10)];
    expect(picture(direct(turns, { wide: { ...OFF.wide, silence: 2 } }))).toEqual([
      [0, 5, "solo", "ana"],
      [5, 10, "solo", "ben"],
    ]);
    const wide = direct(turns, { wide: { ...OFF.wide, silence: 0.5 } });
    expect(picture(wide)).toEqual([
      [0, 4, "solo", "ana"],
      [4, 5, "grid", "ana,ben,cleo"],
      [5, 10, "solo", "ben"],
    ]);
    expect(wide[1]).toMatchObject({ reason: "silence", confidence: 0.8 });
  });

  it("merges a shot shorter than minShot into the one before it", () => {
    const shots = direct([turn("ana", 0, 6), turn("ben", 6, 7), turn("ana", 7, 12)], { minShot: 2 }, 12);
    expect(picture(shots)).toEqual([[0, 12, "solo", "ana"]]);
    // Ben's second of speech under Ana's picture lowers the confidence.
    expect(shots[0]!.confidence).toBe(Math.round(0.95 * (11 / 12) * 100) / 100);
  });

  it("lets the voice lead the cut by cutLead (J-cut)", () => {
    expect(picture(direct([turn("ana", 0, 5), turn("ben", 5, 10)], { cutLead: 0.5 }))).toEqual([
      [0, 5.5, "solo", "ana"],
      [5.5, 10, "solo", "ben"],
    ]);
  });

  it("gives a two-up to two people talking at once long enough, else keeps the shot that was on", () => {
    const turns = [turn("ana", 0, 6), turn("ben", 4, 10)];
    const shots = direct(turns, { twoShot: { exchange: null, overlap: 1 } });
    expect(picture(shots)).toEqual([
      [0, 4, "solo", "ana"],
      [4, 6, "two-up", "ana,ben"],
      [6, 10, "solo", "ben"],
    ]);
    expect(shots[1]!.reason).toBe("ana and ben talk at once");
    expect(picture(direct(turns, { twoShot: { exchange: null, overlap: 3 } }))).toEqual([
      [0, 6, "solo", "ana"],
      [6, 10, "solo", "ben"],
    ]);
  });

  it("holds a two-up over a quick exchange between the same two people", () => {
    const turns = [turn("ana", 0, 1), turn("ben", 1, 2), turn("ana", 2, 3), turn("ben", 3, 4), turn("cleo", 4, 10)];
    const shots = direct(turns, { twoShot: { exchange: 1.5, overlap: null } });
    expect(picture(shots)).toEqual([
      [0, 4, "two-up", "ana,ben"],
      [4, 10, "solo", "cleo"],
    ]);
    expect(shots[0]).toMatchObject({ reason: "quick exchange ana/ben", confidence: 0.85 });
    // Two quick turns are no exchange.
    expect(picture(direct([turn("ana", 0, 1), turn("ben", 1, 10)], { twoShot: { exchange: 1.5, overlap: null } }))[0]).toEqual([0, 1, "solo", "ana"]);
  });

  it("goes wide on laughter: enough people at once, long enough", () => {
    const turns = [turn("ana", 0, 4), turn("ben", 2, 8), turn("cleo", 2, 4)];
    const shots = direct(turns, { wide: { silence: null, laughter: 1, together: 3 } }, 8);
    expect(picture(shots)).toEqual([
      [0, 2, "solo", "ana"],
      [2, 4, "grid", "ana,ben,cleo"],
      [4, 8, "solo", "ben"],
    ]);
    expect(shots[1]!.reason).toBe("laughter or cross-talk");
    // In a group of two, both laughing is everyone.
    const two = ANGLES.slice(0, 2);
    expect(picture(direct([turn("ana", 0, 4), turn("ben", 2, 8)], { wide: { silence: null, laughter: 1, together: 3 } }, 8, two))[1]).toEqual([
      2,
      4,
      "grid",
      "ana,ben",
    ]);
  });

  it("cuts away from a long solo to the listener with the highest weight, or wide", () => {
    const rules = { maxShot: 10, cutaway: { to: "listener" as const, length: 2 }, weights: { cleo: 2 } };
    const shots = direct([turn("ana", 0, 30)], rules, 30);
    expect(picture(shots)).toEqual([
      [0, 10, "solo", "ana"],
      [10, 12, "solo", "cleo"],
      [12, 22, "solo", "ana"],
      [22, 24, "solo", "cleo"],
      [24, 30, "solo", "ana"],
    ]);
    expect(shots[1]).toMatchObject({ reason: "long turn: cleo listens", confidence: 0.4 });
    const wide = direct([turn("ana", 0, 30)], { ...rules, cutaway: { to: "wide", length: 2 } }, 30);
    expect(wide[1]).toMatchObject({ shot: "grid", angles: ["ana", "ben", "cleo"], reason: "long turn: wide", confidence: 0.45 });
    // No cutaway when what would follow it is shorter than minShot.
    expect(picture(direct([turn("ana", 0, 13)], { ...rules, minShot: 2 }, 13))).toEqual([[0, 13, "solo", "ana"]]);
  });

  it("never shows an angle of weight 0 alone, and prefers heavy angles in a two-up", () => {
    expect(picture(direct([turn("ana", 0, 5), turn("ben", 5, 10)], { weights: { ben: 0 } }))).toEqual([[0, 10, "solo", "ana"]]);
    const all = [turn("ana", 0, 10), turn("ben", 0, 10), turn("cleo", 0, 10)];
    expect(picture(direct(all, { twoShot: { exchange: null, overlap: 0.5 }, weights: { cleo: 2 } }))).toEqual([[0, 10, "two-up", "ana,cleo"]]);
  });

  it("guesses a wide when nobody speaks and silences are not a rule", () => {
    expect(direct([], {})).toEqual([{ in: 0, out: 10, shot: "grid", angles: ["ana", "ben", "cleo"], confidence: 0.3, reason: "no clear speaker" }]);
  });

  it("shows the only angle with a picture", () => {
    const angles = [ANGLES[0]!, { id: "mic", picture: false }];
    expect(direct([turn("mic", 0, 10)], {}, 10, angles)).toEqual([
      { in: 0, out: 10, shot: "solo", angles: ["ana"], confidence: 1, reason: "only angle with a picture" },
    ]);
  });

  it("puts cuts on the frame grid it is given", () => {
    const snap = (time: number) => Math.round(Math.round(time * 30) / 30 * 1000) / 1000;
    const shots = directShots({ angles: ANGLES, turns: [turn("ana", 0, 3.21), turn("ben", 3.21, 10)], rules: OFF, from: 0, to: 10, snap });
    expect(shots.map((shot) => shot.out)).toEqual([3.2, 10]);
    expect(shots[1]!.in).toBe(3.2);
  });

  it("is deterministic and covers the span for every template", () => {
    const turns = randomTurns(7, 600);
    for (const id of DIRECTOR_TEMPLATE_IDS) {
      const run = () => directShots({ angles: ANGLES, turns, rules: DIRECTOR_TEMPLATES[id], from: 0, to: 600 });
      const shots = run();
      expect(run(), id).toEqual(shots);
      expect(shots[0]!.in).toBe(0);
      expect(shots.at(-1)!.out).toBe(600);
      for (let i = 1; i < shots.length; i++) expect(shots[i]!.in, `${id} shot ${i}`).toBe(shots[i - 1]!.out);
      for (const shot of shots) {
        expect(shot.confidence).toBeGreaterThanOrEqual(0);
        expect(shot.confidence).toBeLessThanOrEqual(1);
      }
      // Only the last shot of the span may be shorter than minShot.
      expect(shots.slice(0, -1).every((shot) => shot.out - shot.in >= DIRECTOR_TEMPLATES[id].minShot - 1e-6), id).toBe(true);
    }
  });
});

/** A seeded conversation: turns of 0.3-12 s by random people, with pauses and overlaps. */
function randomTurns(seed: number, length: number): DirectorTurn[] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const turns: DirectorTurn[] = [];
  let at = 0;
  while (at < length) {
    const angle = ANGLES[Math.floor(random() * ANGLES.length)]!.id;
    const duration = 0.3 + random() * 12;
    const start = Math.max(0, at - random() * 1.5);
    const end = Math.min(length, start + duration);
    const previous = turns.findLast((candidate) => candidate.angle === angle);
    if (!previous || start > previous.end) turns.push(turn(angle, Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000));
    at = end + random() * 3;
  }
  return turns;
}
