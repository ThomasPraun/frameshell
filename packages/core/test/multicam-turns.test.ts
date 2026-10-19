import { describe, expect, it } from "vitest";
import { ENERGY_HOP_S, energyProfile } from "../src/media/energy.js";
import { BLEED_DB, MERGE_GAP_S, MIN_TURN_S, speakingTurns } from "../src/multicam/turns.js";

const FLOOR_DB = -70;
const SPEECH_DB = -20;

/** Envelope of one mic: speech at `SPEECH_DB` over `own`, other people's speech `bleedDb` lower, room noise otherwise. */
function mic(duration: number, own: [number, number][], others: [number, number][] = [], bleedDb = 20) {
  const db = new Float32Array(Math.round(duration / ENERGY_HOP_S)).fill(FLOOR_DB);
  const paint = (spans: [number, number][], level: number) => {
    for (const [from, to] of spans) db.fill(level, Math.round(from / ENERGY_HOP_S), Math.round(to / ENERGY_HOP_S));
  };
  paint(others, SPEECH_DB - bleedDb);
  paint(own, SPEECH_DB);
  return energyProfile(db);
}

const near = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThanOrEqual(0.06);

describe("speakingTurns", () => {
  const ana: [number, number][] = [[1, 4]];
  const ben: [number, number][] = [[5, 8]];
  const zoe: [number, number][] = [[9, 12]];
  const all = [...ana, ...ben, ...zoe];
  const minus = (own: [number, number][]) => all.filter((span) => !own.includes(span));

  it("gives each of three mics its own turns when the others bleed in at -20 dB", () => {
    const turns = speakingTurns(
      [
        { id: "ana", offset: 0, profile: mic(14, ana, minus(ana)) },
        { id: "ben", offset: 0, profile: mic(14, ben, minus(ben)) },
        { id: "zoe", offset: 0, profile: mic(14, zoe, minus(zoe)) },
      ],
      14,
    );
    expect(turns.map((turn) => turn.angle)).toEqual(["ana", "ben", "zoe"]);
    [ana[0]!, ben[0]!, zoe[0]!].forEach((span, i) => {
      near(turns[i]!.start, span[0]);
      near(turns[i]!.end, span[1]);
    });
  });

  it("would count the bleed as turns without the cross-mic comparison margin", () => {
    // A bleed only 6 dB down is within the margin: it counts, which is what overlapping speech looks like.
    const turns = speakingTurns(
      [
        { id: "ana", offset: 0, profile: mic(14, ana, ben, 6) },
        { id: "ben", offset: 0, profile: mic(14, ben, ana, 6) },
      ],
      14,
    );
    expect(BLEED_DB).toBeGreaterThan(6);
    expect(turns.filter((turn) => turn.angle === "ana")).toHaveLength(2);
  });

  it("keeps overlaps as overlaps", () => {
    const turns = speakingTurns(
      [
        { id: "ana", offset: 0, profile: mic(10, [[1, 6]], [[6, 9]]) },
        { id: "ben", offset: 0, profile: mic(10, [[4, 9]], [[1, 4]]) },
      ],
      10,
    );
    expect(turns).toHaveLength(2);
    near(turns[0]!.end, 6);
    near(turns[1]!.start, 4);
    expect(turns[0]!.end).toBeGreaterThan(turns[1]!.start);
  });

  it("bridges short pauses, drops short sounds and survives a dip in level", () => {
    const profile = mic(
      10,
      [
        [1, 2],
        [2 + MERGE_GAP_S - 0.1, 4],
        [6, 6 + MIN_TURN_S - 0.1],
        [8, 8.5],
      ],
    );
    const turns = speakingTurns([{ id: "ana", offset: 0, profile }], 10);
    expect(turns).toHaveLength(2);
    near(turns[0]!.start, 1);
    near(turns[0]!.end, 4);
    near(turns[1]!.start, 8);
  });

  it("puts turns on the group clock using each angle's offset and caps them at the group's end", () => {
    const turns = speakingTurns(
      [
        { id: "ana", offset: 0, profile: mic(10, [[1, 3]]) },
        { id: "ben", offset: 2.5, profile: mic(7.5, [[3, 5], [6, 7.5]]) },
      ],
      10,
    );
    const ben = turns.filter((turn) => turn.angle === "ben");
    near(ben[0]!.start, 5.5);
    near(ben[0]!.end, 7.5);
    expect(ben[1]!.end).toBeLessThanOrEqual(10);
    expect(turns.map((turn) => turn.start)).toEqual([...turns.map((turn) => turn.start)].sort((a, b) => a - b));
  });

  it("gives an angle without sound no turns and nobody turns in silence", () => {
    expect(speakingTurns([{ id: "ana", offset: 0, profile: null }, { id: "ben", offset: 0, profile: mic(5, []) }], 5)).toEqual([]);
  });
});
