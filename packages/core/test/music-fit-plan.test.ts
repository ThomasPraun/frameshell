import { ErrorCode, RpcError } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { type FitRequest, planFit } from "../src/music/fit.js";

// `planFit`: the arithmetic of music.fit at 30 fps. A 40 s track whose final hit is at 30 s of the file.
const clip = { start: 0, in: 0, out: 40, speed: 1 };
const fit = (overrides: Partial<FitRequest>) => planFit({ clip, end: 36, hit: 30, exact: false, fps: 30, ...overrides });
const refusal = (run: () => unknown): RpcError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("planFit, sliding", () => {
  it("back-times the clip so the hit lands on the end, and reports where the music starts", () => {
    const plan = fit({});
    expect(plan.mode).toBe("slide");
    expect(plan.after).toEqual({ start: 6, in: 0, speed: 1, out: 40 });
    expect(plan.operations).toEqual([{ op: "clip.move", args: { start: 6 } }]);
    expect(plan.landsAt).toBe(36);
    expect(plan.offsetMs).toBe(0);
    expect(plan.tail).toBe(10);
    // The track is shorter than the picture before the hit: nothing plays in the first 6 s, and it is not looped.
    expect(plan.silentBefore).toBe(6);
    expect(plan.introCut).toBe(0);
    expect(plan.warnings.join(" ")).toContain("never looped or spliced");
  });

  it("drops the start of the track when it would begin before the earliest start", () => {
    const plan = fit({ end: 20 });
    expect(plan.after).toEqual({ start: 0, in: 10, speed: 1, out: 40 });
    expect(plan.operations).toEqual([
      { op: "clip.trim", args: { in: 10, snap: false } },
      { op: "clip.move", args: { start: 0 } },
    ]);
    expect(plan.introCut).toBe(10);
    expect(plan.silentBefore).toBe(0);
    expect(plan.landsAt).toBe(20);
    expect(plan.steps.map((step) => step.id)).toEqual(["intro"]);
  });

  it("respects `from` as the earliest start", () => {
    const plan = fit({ end: 40, from: 12 });
    expect(plan.after.start).toBe(12);
    expect(plan.after.in).toBe(2);
    expect(plan.landsAt).toBe(40);
    expect(plan.introCut).toBe(2);
  });

  it("keeps the speed the clip has, and lands within half a frame when the hit is between frames", () => {
    const quick = fit({ clip: { ...clip, speed: 1.25 }, hit: 30, end: 36 });
    expect(quick.after.speed).toBe(1.25);
    expect(quick.after.start).toBe(12);
    expect(quick.landsAt).toBe(36);
    const between = fit({ hit: 30.0123, end: 36 });
    expect(Math.abs(between.offsetMs)).toBeLessThanOrEqual(1000 / 30 / 2 + 0.05);
    expect(between.landsAt).toBeCloseTo(36 + between.offsetMs / 1000, 3);
  });

  it("changes nothing when the hit already lands on the end", () => {
    const plan = fit({ clip: { ...clip, start: 6 } });
    expect(plan.operations).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("nothing to change");
  });

  it("refuses a hit outside the played part and an end that is not after the earliest start", () => {
    expect(refusal(() => fit({ hit: 45 })).data).toMatchObject({ reason: "hit outside the clip", field: "hit" });
    expect(refusal(() => fit({ hit: 0 })).code).toBe(ErrorCode.InvalidOperation);
    expect(refusal(() => fit({ end: 5, from: 5 })).data).toMatchObject({ reason: "end before start", field: "end" });
  });
});

describe("planFit, exact", () => {
  it("keeps the start and varispeeds so the hit lands exactly", () => {
    const plan = fit({ exact: true, end: 30.4 });
    expect(plan.mode).toBe("exact");
    expect(plan.after.start).toBe(0);
    expect(plan.after.speed).toBe(0.986842);
    expect(plan.operations).toEqual([{ op: "clip.set", args: { speed: 0.986842 } }]);
    expect(plan.speedChangePercent).toBeCloseTo(-1.316, 2);
    expect(plan.landsAt).toBe(30.4);
    expect(plan.offsetMs).toBeCloseTo(0, 1);
    expect(plan.introCut).toBe(0);
  });

  it("starts where `from` says and speeds up when the track is long", () => {
    const plan = fit({ exact: true, from: 1, end: 30.5, clip: { ...clip, start: 3 } });
    expect(plan.after.start).toBe(1);
    expect(plan.after.speed).toBeCloseTo(30 / 29.5, 6);
    expect(plan.operations.map((operation) => operation.op)).toEqual(["clip.set", "clip.move"]);
    expect(plan.speedChangePercent).toBeCloseTo(1.695, 2);
  });

  it("takes the limit from the clip's own speed, not from 1", () => {
    const plan = fit({ exact: true, end: 24.1, clip: { ...clip, speed: 1.25 } });
    expect(plan.after.speed).toBeCloseTo(30 / 24.1, 6);
    expect(Math.abs(plan.speedChangePercent!)).toBeLessThan(1.7);
  });

  it("refuses past 1.7 % and says which ends fit and what else to do", () => {
    const error = refusal(() => fit({ exact: true, end: 31 }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toContain("slower by 3.23 %");
    expect(error.message).toContain("limit is ±1.7 %");
    expect(error.data).toMatchObject({ reason: "varispeed limit", needed: { percent: -3.23, max: 1.7 } });
    const { min, max } = (error.data as { valid: { end: { min: number; max: number } } }).valid.end;
    // Both ends of the offered window plan cleanly, and one frame outside either does not.
    expect(fit({ exact: true, end: min }).speedChangePercent).toBeGreaterThanOrEqual(-1.7);
    expect(fit({ exact: true, end: max }).speedChangePercent).toBeLessThanOrEqual(1.7);
    expect(() => fit({ exact: true, end: min - 1 / 30 })).toThrow();
    expect(() => fit({ exact: true, end: max + 1 / 30 })).toThrow();
    expect(String((error.data as { hint: string }).hint)).toContain("drop `exact`");
  });

  it("does not change a speed that is already right", () => {
    const plan = fit({ exact: true, end: 30 });
    expect(plan.operations).toEqual([]);
    expect(plan.speedChangePercent).toBeNull();
  });
});
