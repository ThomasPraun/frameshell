import { describe, expect, it } from "vitest";
import { DIRECTOR_TEMPLATES, DIRECTOR_TEMPLATE_IDS, DirectorRulesSchema, parseDirectorFile, resolveDirectorRules } from "../src/index.js";

describe("director.json", () => {
  it("ships valid rules for every template", () => {
    for (const id of DIRECTOR_TEMPLATE_IDS) expect(DirectorRulesSchema.safeParse(DIRECTOR_TEMPLATES[id]).success, id).toBe(true);
  });

  it("resolves to the interview template when nothing is given", () => {
    expect(resolveDirectorRules(null)).toEqual({ template: "interview", rules: DIRECTOR_TEMPLATES.interview });
  });

  it("puts the file's fields over its template, objects field by field", () => {
    const parsed = parseDirectorFile({ template: "podcast-calm", minShot: 3, maxShot: null, wide: { silence: null }, weights: { ana: 2 } });
    expect(parsed.ok).toBe(true);
    const { template, rules } = resolveDirectorRules(parsed.ok ? parsed.value : null);
    expect(template).toBe("podcast-calm");
    expect(rules).toEqual({
      ...DIRECTOR_TEMPLATES["podcast-calm"],
      minShot: 3,
      maxShot: null,
      wide: { ...DIRECTOR_TEMPLATES["podcast-calm"].wide, silence: null },
      weights: { ana: 2 },
    });
  });

  it("lets the call's template replace the file's", () => {
    const parsed = parseDirectorFile({ template: "podcast-calm", cutLead: 0 });
    const { template, rules } = resolveDirectorRules(parsed.ok ? parsed.value : null, "panel-dynamic");
    expect(template).toBe("panel-dynamic");
    expect(rules).toEqual({ ...DIRECTOR_TEMPLATES["panel-dynamic"], cutLead: 0 });
  });

  it("rejects unknown keys, templates and out-of-range values", () => {
    expect(parseDirectorFile({ minShots: 2 }).ok).toBe(false);
    expect(parseDirectorFile({ template: "news" }).ok).toBe(false);
    expect(parseDirectorFile({ cutLead: -1 }).ok).toBe(false);
    expect(parseDirectorFile({ weights: { ana: -1 } }).ok).toBe(false);
    expect(parseDirectorFile({ wide: { together: 1 } }).ok).toBe(false);
  });
});
