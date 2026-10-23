import { describe, expect, it } from "vitest";
import { pickedCutout } from "../src/renderer/src/preview/cut-out.js";
import type { SelectedPoint } from "../src/renderer/src/selection.js";

// Seam under test: which picked point "Cut out as layer" acts on (ADR 0022).

const mask = (k: number) => ({ mask: `.frameshell/context/m_0_10_20_${k}.png`, bbox: [0, 0, 1, 1] as [number, number, number, number], frameBox: [0, 0, 1, 1] as [number, number, number, number], area: 0.1, score: 0.5 });
const segmented = (target: string | null, chosen: number): SelectedPoint => ({
  x: 0.5,
  y: 0.5,
  at: 0,
  layers: [],
  target,
  elements: [],
  unavailable: null,
  segment: { asset: "assets/a.png", size: { width: 4, height: 4 }, model: "mobilesam@00000000", chosen, masks: [mask(1), mask(2), mask(3)] },
});

describe("pickedCutout", () => {
  it("takes the chosen mask of the last segmented point that names a clip", () => {
    expect(pickedCutout({ points: [segmented("c_a", 0), segmented("c_b", 2)] })).toEqual({ clip: "c_b", mask: ".frameshell/context/m_0_10_20_3.png" });
    expect(pickedCutout({ points: [segmented("c_a", 1), segmented(null, 2)] })).toEqual({ clip: "c_a", mask: ".frameshell/context/m_0_10_20_2.png" });
  });

  it("is null without a segmented point", () => {
    expect(pickedCutout({ points: [] })).toBeNull();
    expect(pickedCutout({ points: [{ ...segmented("c_a", 0), segment: undefined }] })).toBeNull();
  });
});
