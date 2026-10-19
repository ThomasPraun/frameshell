import type { MediaProbe } from "@frameshell/protocol";
import type { MulticamGroup } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { ENERGY_HOP_S, type EnergyProfile } from "../src/media/energy.js";
import { groupTurns } from "../src/multicam/group-turns.js";

// A screen recording carrying the mixed call is the loudest track; it must not mask a person (ADR 0016).
const hops = (seconds: number, level: (second: number) => number): EnergyProfile => ({
  db: Float32Array.from({ length: Math.round(seconds / ENERGY_HOP_S) }, (_, i) => level(i * ENERGY_HOP_S)),
  threshold: -50,
});
const profiles: Record<string, EnergyProfile> = {
  "ana.mp4": hops(10, (t) => (t >= 2 && t < 6 ? -40 : -90)),
  "call.mp4": hops(10, (t) => (t >= 2 && t < 6 ? -10 : -90)),
};
const source = {
  probe: async () => ({ audio: {} }) as unknown as MediaProbe,
  profile: async (_root: string, asset: string) => profiles[asset]!,
};
const angles = [
  { id: "ana", name: "Ana", asset: "ana.mp4", offset: 0 },
  { id: "call", name: "Call", asset: "call.mp4", offset: 0, screen: true },
];

describe("groupTurns with a screen angle", () => {
  it("keeps a person's turn when the screen's sound is far louder", async () => {
    const { turns } = await groupTurns(source, "/p", { id: "g", angles } as MulticamGroup);
    expect(turns.filter((turn) => turn.angle === "ana").length).toBe(1);
  });

  it("keeps a person heard through a mic when the screen shares that mic", async () => {
    const group = {
      id: "g",
      angles: [
        { id: "ana", name: "Ana", asset: "silent.mp4", offset: 0, mic: "lav" },
        { id: "call", name: "Call", asset: "call.mp4", offset: 0, screen: true, mic: "lav" },
      ],
      mics: [{ id: "lav", name: "Lav", asset: "ana.mp4", offset: 0 }],
    } as MulticamGroup;
    const { turns, warnings } = await groupTurns(source, "/p", group);
    expect(turns.map((turn) => turn.angle)).toEqual(["ana"]);
    expect(warnings).toEqual([]);
  });

  it("warns about a silent person but not about a silent screen", async () => {
    const quiet = { ...source, probe: async (_root: string, asset: string) => ({ audio: asset === "ana.mp4" ? {} : undefined }) as unknown as MediaProbe };
    const group = {
      id: "g",
      angles: [
        { id: "ana", name: "Ana", asset: "ana.mp4", offset: 0 },
        { id: "ben", name: "Ben", asset: "ben.mp4", offset: 0 },
        { id: "deck", name: "Deck", asset: "deck.mp4", offset: 0, screen: true },
      ],
    } as MulticamGroup;
    const { warnings } = await groupTurns(quiet, "/p", group);
    expect(warnings).toEqual(["Ben (ben.mp4) has no sound, so it has no turns."]);
  });
});
