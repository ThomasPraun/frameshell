import type { DaemonConnection, GradeLooksResult } from "@frameshell/protocol";
import { GRADE_LOOKS, lookGrade } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { executeTimeline, parseLook, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: the built-in looks (ADR 0031 decision 8) from argv: `grade looks`, `clip set --grade-look`, and a
// built-in name as a `grade compare --look`.

const reply: GradeLooksResult = { looks: GRADE_LOOKS.map(({ name, summary, grade }) => ({ name, summary, grade: { ...grade } })) };

function stub() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return reply;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("grade looks", () => {
  it("sends no params and no project to grade.looks", () => {
    expect(parseTimelineCommand(["grade", "looks"], {})).toEqual({ kind: "timeline", method: "grade.looks", params: {}, withCwd: false });
    expect(() => parseTimelineCommand(["grade", "looks", "c_talk"], {})).toThrow(/takes 0 argument/);
    expect(() => parseTimelineCommand(["grade", "looks"], { timeline: "main" })).toThrow(/does not take --timeline/);
    expect(() => parseTimelineCommand(["grade", "looks"], { at: "1" })).toThrow(/does not take --at/);
  });

  it("prints every look with its summary and numbers, and how to keep one", async () => {
    const { conn, sent } = stub();
    const text = await executeTimeline(conn, parseTimelineCommand(["grade", "looks"], {})!, "/p", false);
    expect(sent).toEqual([{ method: "grade.looks", params: {} }]);
    for (const look of GRADE_LOOKS) expect(text).toContain(look.name);
    expect(text).toContain("exposure 0.05  temperature 0.4  tint 0.04  contrast 1.04  saturation 1.08");
    expect(text).toContain("clip set <clip> --grade-look <name>");
  });

  it("gives --json the daemon's result as it is", async () => {
    const { conn } = stub();
    expect(JSON.parse(await executeTimeline(conn, parseTimelineCommand(["grade", "looks"], {})!, "/p", true))).toEqual(reply);
  });
});

describe("clip set --grade-look", () => {
  const grade = (values: Record<string, string | boolean>) => parseTimelineCommand(["clip", "set", "c_talk"], values)!.params["grade"];

  it("copies the look's five numbers into the clip's grade", () => {
    expect(grade({ "grade-look": "warm" })).toEqual(lookGrade("warm"));
    expect(grade({ "grade-look": "mono" })).toEqual(lookGrade("mono"));
  });

  it("lets explicit --grade-* flags win over the look, and keeps a LUT choice", () => {
    expect(grade({ "grade-look": "punchy", "grade-saturation": "1.1", "grade-lut": "luts/teal.cube" })).toEqual({ ...lookGrade("punchy"), saturation: 1.1, lut: "luts/teal.cube" });
    expect(grade({ "grade-look": "faded", "grade-exposure": "-0.3" })).toEqual({ ...lookGrade("faded"), exposure: -0.3 });
    expect(grade({ "grade-lut": "none" })).toEqual({ lut: null });
  });

  it("refuses an unknown look, naming the valid ones, and --clear-grade with a look", () => {
    expect(() => grade({ "grade-look": "sepia" })).toThrow(/no built-in look "sepia".*warm, cool, filmic, punchy, faded, mono/);
    expect(() => grade({ "grade-look": "warm", "clear-grade": true })).toThrow(/--clear-grade alone/);
    expect(() => parseTimelineCommand(["clip", "move", "c_talk"], { "grade-look": "warm" })).toThrow(/does not take --grade-look/);
  });
});

describe("grade compare --look with a built-in look", () => {
  it("takes a bare built-in name and look=<name> with fields over it", () => {
    expect(parseLook("warm")).toEqual({ look: "warm" });
    expect(parseLook("mine:look=warm,saturation=1.1")).toEqual({ name: "mine", look: "warm", saturation: 1.1 });
    expect(parseLook("look=cool")).toEqual({ look: "cool" });
    expect(parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["warm", "mine:look=filmic,contrast=1"] })!.params).toMatchObject({
      looks: [{ look: "warm" }, { name: "mine", look: "filmic", contrast: 1 }],
    });
  });

  it("still refuses a bare word that is not a built-in look, naming the choices", () => {
    expect(() => parseLook("sepia")).toThrow(/--look: expected a built-in look \(warm, cool, filmic, punchy, faded, mono\)/);
  });
});
