import type { MediaProbe } from "@frameshell/protocol";
import type { MulticamGroup } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { ENERGY_HOP_S, type EnergyProfile } from "../src/media/energy.js";
import { groupTurns } from "../src/multicam/group-turns.js";
import { applyPainted } from "../src/multicam/turns.js";

const hops = (seconds: number, level: (second: number) => number): EnergyProfile => ({
  db: Float32Array.from({ length: Math.round(seconds / ENERGY_HOP_S) }, (_, i) => level(i * ENERGY_HOP_S)),
  threshold: -50,
});
// Ana talks 1-4 s, Ben 6-9 s.
const profiles: Record<string, EnergyProfile> = {
  "ana.mp4": hops(10, (t) => (t >= 1 && t < 4 ? -30 : -90)),
  "ben.mp4": hops(10, (t) => (t >= 6 && t < 9 ? -30 : -90)),
};
const source = {
  probe: async () => ({ audio: {} }) as unknown as MediaProbe,
  profile: async (_root: string, asset: string) => profiles[asset]!,
  transcript: async () => null,
};
const group = (painted?: MulticamGroup["painted"]): MulticamGroup => ({
  id: "g",
  angles: [
    { id: "ana", name: "Ana", asset: "ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "ben.mp4", offset: 0 },
  ],
  ...(painted ? { painted } : {}),
});
const spans = (turns: { angle: string; start: number; end: number }[]) => turns.map(({ angle, start, end }) => [angle, start, end]);

describe("applyPainted", () => {
  const turns = [
    { angle: "ana", start: 1, end: 4 },
    { angle: "ben", start: 6, end: 9 },
  ];

  it("returns the turns untouched without painted stretches", () => {
    expect(applyPainted(turns, [])).toEqual(turns);
  });

  it("cuts a turn out where its angle is painted silent, dropping slivers", () => {
    const result = applyPainted(turns, [{ angle: "ana", start: 2, end: 3, speaking: false }]);
    expect(spans(result)).toEqual([
      ["ana", 1, 2],
      ["ana", 3, 4],
      ["ben", 6, 9],
    ]);
    expect(spans(applyPainted(turns, [{ angle: "ana", start: 1.2, end: 4, speaking: false }]))).toEqual([["ben", 6, 9]]);
  });

  it("adds a spoken stretch however short, and joins turns it touches", () => {
    const result = applyPainted(turns, [
      { angle: "ana", start: 4, end: 4.1, speaking: true },
      { angle: "ben", start: 0, end: 0.1, speaking: true },
    ]);
    expect(spans(result)).toEqual([
      ["ben", 0, 0.1],
      ["ana", 1, 4.1],
      ["ben", 6, 9],
    ]);
  });

  it("leaves angles without painted stretches alone", () => {
    const result = applyPainted(turns, [{ angle: "ben", start: 0, end: 20, speaking: false }]);
    expect(spans(result)).toEqual([["ana", 1, 4]]);
  });
});

describe("groupTurns with painted turns", () => {
  it("measures without painting", async () => {
    const { turns } = await groupTurns(source, "/p", group());
    expect(spans(turns).map(([angle]) => angle)).toEqual(["ana", "ben"]);
  });

  it("takes a painted stretch over what the sound says", async () => {
    const painted = [
      { angle: "ana", start: 5, end: 7, speaking: true },
      { angle: "ben", start: 6, end: 7, speaking: false },
    ];
    const { turns } = await groupTurns(source, "/p", group(painted));
    const ana = turns.filter((turn) => turn.angle === "ana");
    const ben = turns.filter((turn) => turn.angle === "ben");
    expect(spans(ana)).toEqual([
      ["ana", 1, 4],
      ["ana", 5, 7],
    ]);
    expect(ben[0]!.start).toBeGreaterThanOrEqual(7);
    expect(ana[1]!.name).toBe("Ana");
  });

  it("ignores speaking stretches painted on an angle that is now a screen", async () => {
    const base = group([{ angle: "ben", start: 2, end: 3, speaking: true }]);
    const screened = { ...base, angles: base.angles.map((angle) => (angle.id === "ben" ? { ...angle, screen: true } : angle)) };
    const { turns } = await groupTurns(source, "/p", screened);
    expect(turns.filter((turn) => turn.angle === "ben")).toEqual([]);
  });
});
