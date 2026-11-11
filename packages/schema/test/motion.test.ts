import { describe, expect, it } from "vitest";
import {
  EASE_CURVES,
  ROLE_EASES,
  SPRING_PRESETS,
  type SpringLike,
  durationFromDistance,
  ease,
  settle,
  spring,
  springStep,
  stagger,
  track,
} from "../src/index.js";

/** Largest value of a 0 → 1 step over its first 3 s, sampled every 0.1 ms, minus 1. */
function overshoot(preset: SpringLike): number {
  let peak = 0;
  for (let t = 0; t <= 3; t += 1e-4) peak = Math.max(peak, spring(preset, t));
  return peak - 1;
}

describe("spring presets", () => {
  it("overshoot as named: snappy about 1.5 %, default 0.5 %, heavy none, playful about 20 %", () => {
    expect(overshoot("snappy")).toBeCloseTo(0.0152, 3);
    expect(overshoot("default")).toBeCloseTo(0.005, 3);
    expect(overshoot("heavy")).toBeLessThanOrEqual(0);
    expect(overshoot("playful")).toBeCloseTo(0.205, 2);
  });

  it("match the textbook peak exp(−πζ/√(1−ζ²)) of an under-damped step", () => {
    for (const id of ["snappy", "default", "playful"] as const) {
      const z = SPRING_PRESETS[id].damping;
      expect(overshoot(id)).toBeCloseTo(Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z)), 4);
    }
  });

  it("start at rest on 0, reach the target, and hold 0 before the start", () => {
    for (const id of Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[]) {
      expect(springStep(id, 0)).toEqual({ value: 0, velocity: 0 });
      expect(springStep(id, -1)).toEqual({ value: 0, velocity: 0 });
      expect(spring(id, 5)).toBeCloseTo(1, 6);
    }
    expect(spring("default", 5, 100, 300)).toBeCloseTo(300, 4);
  });

  it("report the derivative of the value as velocity, for under-, critically and over-damped springs", () => {
    for (const params of [SPRING_PRESETS.playful, SPRING_PRESETS.heavy, { response: 0.4, damping: 1.6 }]) {
      for (const t of [0.01, 0.1, 0.25, 0.6]) {
        const h = 1e-6;
        const numeric = (springStep(params, t + h).value - springStep(params, t - h).value) / (2 * h);
        expect(springStep(params, t).velocity).toBeCloseTo(numeric, 3);
      }
    }
  });

  it("join the critical form continuously on both sides of ζ = 1", () => {
    const at = (damping: number) => springStep({ response: 0.5, damping }, 0.2).value;
    expect(at(1 - 1e-4)).toBeCloseTo(at(1), 4);
    expect(at(1 + 1e-4)).toBeCloseTo(at(1), 4);
  });

  it("refuse unknown presets and springs that never settle", () => {
    expect(() => spring("bouncy" as never, 0.1)).toThrow(/snappy, default, heavy, playful/);
    expect(() => spring({ response: 0.4, damping: 0 }, 0.1)).toThrow(/damping > 0/);
    expect(() => spring({ response: 0, damping: 0.8 }, 0.1)).toThrow(/response > 0/);
  });
});

describe("settle", () => {
  it("is when a step stays within eps for good", () => {
    for (const id of ["snappy", "default", "heavy", "playful"] as const) {
      const eps = 0.001;
      const at = settle(id, eps);
      for (let t = at; t < at + 3; t += 1e-3) expect(Math.abs(1 - spring(id, t))).toBeLessThanOrEqual(eps);
      expect(Math.abs(1 - spring(id, at - 2e-3))).toBeGreaterThan(eps * 0.9);
    }
  });

  it("takes longer for a bouncier spring and a tighter eps", () => {
    expect(settle("playful")).toBeGreaterThan(settle("default"));
    expect(settle("default", 0.0001)).toBeGreaterThan(settle("default", 0.01));
    expect(() => settle("default", 0)).toThrow(/between 0 and 1/);
  });
});

describe("track", () => {
  it("keeps position and velocity continuous across a retarget", () => {
    const value = track("default", 0, [
      { at: 0, to: 100 },
      { at: 0.15, to: -40 },
      { at: 0.5, to: 60 },
    ]);
    for (const at of [0.15, 0.5]) {
      const before = value(at - 1e-9);
      const after = value(at + 1e-9);
      expect(after.value).toBeCloseTo(before.value, 4);
      expect(after.velocity).toBeCloseTo(before.velocity, 2);
    }
    // Mid-flight at the retarget: it was moving, and it keeps moving the same way at first.
    expect(value(0.15).velocity).toBeGreaterThan(100);
    expect(value(0.15 + 1e-3).velocity).toBeGreaterThan(100);
    expect(value(6).value).toBeCloseTo(60, 4);
  });

  it("holds the start before the first move, takes moves in any order, and is one spring with one move", () => {
    const value = track("snappy", 10, [
      { at: 1, to: 30 },
      { at: 0.5, to: 20 },
    ]);
    expect(value(0.2)).toEqual({ value: 10, velocity: 0 });
    expect(value(6).value).toBeCloseTo(30, 4);
    const single = track("playful", 0, [{ at: 0.2, to: 1 }]);
    expect(single(0.5).value).toBeCloseTo(spring("playful", 0.3), 12);
  });
});

describe("ease", () => {
  it("runs from 0 to 1, clamped outside", () => {
    for (const curve of Object.keys(EASE_CURVES) as (keyof typeof EASE_CURVES)[]) {
      expect(ease(curve, 0)).toBe(0);
      expect(ease(curve, 1)).toBe(1);
      expect(ease(curve, -0.5)).toBe(0);
      expect(ease(curve, 1.5)).toBe(1);
    }
  });

  it("evaluates cubic-bezier as CSS does: linear is the identity, out-expo is far ahead early, in-expo far behind", () => {
    expect(ease("linear", 0.37)).toBeCloseTo(0.37, 6);
    expect(ease("out-expo", 0.2)).toBeGreaterThan(0.7);
    expect(ease("in-expo", 0.5)).toBeLessThan(0.15);
    // Symmetric curve: halfway in time is halfway in value.
    expect(ease("in-out-quart", 0.5)).toBeCloseTo(0.5, 6);
  });

  it("lets out-back overshoot, and maps roles to curves", () => {
    let peak = 0;
    for (let f = 0; f <= 1; f += 0.001) peak = Math.max(peak, ease("pop", f));
    expect(peak).toBeGreaterThan(1.05);
    expect(ease("enter", 0.3)).toBe(ease(ROLE_EASES.enter, 0.3));
    expect(ease([0.22, 1, 0.36, 1], 0.3)).toBe(ease("out-quint", 0.3));
    expect(() => ease("bounce" as never, 0.5)).toThrow(/Unknown ease/);
  });

  it("is monotonic for every curve without overshoot", () => {
    for (const curve of ["out-expo", "out-quint", "in-out-quart", "in-expo", "linear"] as const) {
      let last = -1;
      for (let f = 0; f <= 1; f += 0.001) {
        const value = ease(curve, f);
        expect(value).toBeGreaterThanOrEqual(last - 1e-9);
        last = value;
      }
    }
  });
});

describe("stagger", () => {
  it("delays item i by i steps, from either end or the centre outwards", () => {
    expect([0, 1, 2, 3].map((i) => stagger(i, 4, 0.06))).toEqual([0, 0.06, 0.12, 0.18].map((v) => expect.closeTo(v, 9)));
    expect([0, 1, 2, 3].map((i) => stagger(i, 4, 0.06, { from: "end" }))[0]).toBeCloseTo(0.18, 9);
    expect([0, 1, 2].map((i) => stagger(i, 3, 0.1, { from: "center" }))).toEqual([0.1, 0, 0.1]);
    expect(stagger(0, 1, 0.1)).toBe(0);
  });

  it("shrinks the step so the whole stays within the budget", () => {
    expect(stagger(39, 40, 0.03)).toBeCloseTo(0.5, 9);
    expect(stagger(9, 10, 0.08, { maxTotal: 0.36 })).toBeCloseTo(0.36, 9);
  });
});

describe("durationFromDistance", () => {
  it("is (9 + 1.15·√px) frames at 60 fps times the weight", () => {
    expect(durationFromDistance(100)).toBeCloseTo(20.5 / 60, 9);
    expect(durationFromDistance(100, "heavy")).toBeCloseTo((20.5 * 1.35) / 60, 9);
    expect(durationFromDistance(400, "light")).toBeCloseTo((32 * 0.7) / 60, 9);
    expect(durationFromDistance(-100)).toBe(durationFromDistance(100));
  });
});
