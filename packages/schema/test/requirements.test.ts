import { describe, expect, it } from "vitest";
import { CRAFT_CHECKS, parseRequirementsFile } from "../src/index.js";

const base = { schemaVersion: 1 };

describe("requirements.json", () => {
  it("is valid with nothing but the version, and fills the empty parts", () => {
    const parsed = parseRequirementsFile(base);
    expect(parsed).toEqual({ ok: true, value: { schemaVersion: 1, film: {}, clips: [], fail: [], waivers: [] } });
  });

  it("takes the film, caption, clip, fail and waiver parts, with the default loudness tolerance", () => {
    const parsed = parseRequirementsFile({
      ...base,
      film: { maxSeconds: 30, maxStatic: 2, endCard: { minSeconds: 1.5 }, loudness: { target: -14, maxTruePeak: -1 } },
      captions: { minSize: 0.026 },
      clips: [{ clip: "c_1", appearsBy: "hook+0.5", before: "c_2", keepsMoving: { maxStatic: 2 } }],
      fail: ["static", "reading"],
      waivers: [{ check: "static", clip: "c_1", reason: "the product shot holds on purpose" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.film.loudness).toEqual({ target: -14, tolerance: 1.5, maxTruePeak: -1 });
  });

  it("refuses an unknown key, an unknown check, a waiver with no reason and a wrong version", () => {
    expect(parseRequirementsFile({ ...base, film: { maxSecs: 3 } }).ok).toBe(false);
    expect(parseRequirementsFile({ ...base, fail: ["loud"] }).ok).toBe(false);
    expect(parseRequirementsFile({ ...base, waivers: [{ check: "static", reason: "  " }] }).ok).toBe(false);
    expect(parseRequirementsFile({ schemaVersion: 2 }).ok).toBe(false);
  });

  it("names the craft checks review raises", () => {
    expect(CRAFT_CHECKS).toContain("safe-zone");
    expect(CRAFT_CHECKS).toContain("static");
  });
});
