import { describe, expect, it } from "vitest";
import { GRADE_LIMITS, GRADE_LOOKS, GradeSchema, applyGradeTable, findLook, gradeTable, isIdentityGrade, lookGrade, lookNames, lookOf, normalizeGrade } from "../src/index.js";
import type { Grade } from "../src/index.js";

describe("built-in looks (ADR 0031 decision 8)", () => {
  it("lists the six looks of the table once each, lower case", () => {
    expect(lookNames).toEqual(["warm", "cool", "filmic", "punchy", "faded", "mono"]);
    expect(new Set(lookNames).size).toBe(lookNames.length);
    for (const look of GRADE_LOOKS) {
      expect(look.name).toMatch(/^[a-z]+$/);
      expect(look.summary.length).toBeGreaterThan(10);
    }
  });

  it.each(GRADE_LOOKS.map((look) => [look.name, look] as const))("%s is a whole grade inside the limits that changes colours", (_name, look) => {
    expect(GradeSchema.safeParse(look.grade).success).toBe(true);
    for (const field of ["exposure", "temperature", "tint", "contrast", "saturation"] as const) {
      expect(look.grade[field]).toBeGreaterThanOrEqual(GRADE_LIMITS[field].min);
      expect(look.grade[field]).toBeLessThanOrEqual(GRADE_LIMITS[field].max);
    }
    expect(isIdentityGrade(normalizeGrade(look.grade))).toBe(false);
    expect(look.grade).not.toHaveProperty("lut");
  });

  it.each(GRADE_LOOKS.map((look) => [look.name, look] as const))("%s makes a finite table that never turns a ramp of grey around", (_name, look) => {
    const table = gradeTable(normalizeGrade(look.grade), null);
    expect(table.data.every(Number.isFinite)).toBe(true);
    let last = [-1, -1, -1];
    for (let level = 0; level <= 255; level += 5) {
      const out = applyGradeTable(table, [level, level, level]);
      // Each channel only goes up with the level (equal while the picture clips).
      for (let c = 0; c < 3; c++) expect(out[c]!).toBeGreaterThanOrEqual(last[c]! - 1e-3);
      last = out;
    }
  });

  it("gives a copy of a look and nothing for a name that is not one", () => {
    const grade = lookGrade("warm")!;
    expect(grade).toEqual(findLook("warm")!.grade);
    grade.exposure = 3;
    expect(lookGrade("warm")!.exposure).toBe(0.05);
    expect(lookGrade("Warm")).toBeUndefined();
    expect(findLook("sepia")).toBeUndefined();
  });

  it("warm leans red, cool leans blue, mono has no colour, punchy has more of both than faded", () => {
    const grey = (name: string): number[] => applyGradeTable(gradeTable(normalizeGrade(lookGrade(name)!), null), [120, 120, 120]);
    expect(grey("warm")[0]! - grey("warm")[2]!).toBeGreaterThan(6);
    expect(grey("cool")[2]! - grey("cool")[0]!).toBeGreaterThan(6);
    const mono = grey("mono");
    expect(Math.max(...mono) - Math.min(...mono)).toBeLessThan(2);
    expect(lookGrade("punchy")!.contrast!).toBeGreaterThan(lookGrade("faded")!.contrast!);
    expect(lookGrade("punchy")!.saturation!).toBeGreaterThan(lookGrade("faded")!.saturation!);
  });
});

describe("lookOf", () => {
  it("names the look a grade carries, and none once a number moved", () => {
    expect(lookOf({ ...lookGrade("mono")!, lut: "luts/x.cube" } as Grade)?.name).toBe("mono");
    expect(lookOf({ ...lookGrade("warm")!, saturation: 1.2 } as Grade)).toBeUndefined();
    expect(lookOf(null)).toBeUndefined();
  });
});
