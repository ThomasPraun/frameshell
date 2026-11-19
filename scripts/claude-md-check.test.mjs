import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { pathOf, resolvePath, ruleId, ruleKept, ruleKeys, shippedReason, tokensOf } from "./claude-md-check.mjs";

const pluginFiles = (dir) => (dir === "plugins/blender" ? ["dist", "python", "frameshell-plugin.json", "skills"] : ["dist", "skills"]);

describe("shippedReason", () => {
  it("refuses dirs that reach users", () => {
    for (const path of [
      "skills/frameshell/CLAUDE.md",
      "skills/frameshell/reference/CLAUDE.md",
      "plugins/hyperframes/skills/hyperframes/CLAUDE.md",
      "plugins/blender/python/CLAUDE.md",
      "packages/core/CLAUDE.md",
      "packages/schema/json-schema/CLAUDE.md",
      "apps/desktop/out/CLAUDE.md",
      "website/public/CLAUDE.md",
    ]) {
      expect(shippedReason(path, pluginFiles), path).not.toBeNull();
    }
  });

  it("allows source, test and plugin or app roots", () => {
    for (const path of [
      "CLAUDE.md",
      "packages/core/src/CLAUDE.md",
      "packages/core/src/export/CLAUDE.md",
      "packages/core/test/CLAUDE.md",
      "apps/desktop/CLAUDE.md",
      "apps/desktop/src/main/CLAUDE.md",
      "plugins/CLAUDE.md",
      "plugins/blender/CLAUDE.md",
      "plugins/blender/src/CLAUDE.md",
    ]) {
      expect(shippedReason(path, pluginFiles), path).toBeNull();
    }
  });
});

describe("pathOf", () => {
  it("keeps repo paths, cut at a glob or brace", () => {
    expect(pathOf("packages/core/src/media/recipe.ts")).toBe("packages/core/src/media/recipe.ts");
    expect(pathOf("packages/protocol/src/methods/*.ts")).toBe("packages/protocol/src/methods/");
    expect(pathOf("packages/{schema,protocol}")).toBe("packages/");
    expect(pathOf("docs/adr/")).toBe("docs/adr/");
    expect(pathOf("recipe.ts")).toBe("recipe.ts");
  });

  it("skips code, project paths and numbers", () => {
    for (const span of ["ExportService.planRender", "audio.duck", ".frameshell/cache/mattes/", "beats/<stem>.beats.json", "2/255", "file://localhost/", "frameshell.json", "--snap-to beat|bar|marker"]) {
      expect(pathOf(span), span).toBeNull();
    }
  });
});

describe("resolvePath", () => {
  const entries = new Set(["packages/", "packages/core/", "packages/core/src/", "packages/core/src/media/", "packages/core/src/media/recipe.ts", "packages/core/src/gc.ts"]);

  it("resolves from the CLAUDE.md dir, its parents, then as a tail", () => {
    expect(resolvePath("recipe.ts", "packages/core/src/media", entries)).toBe("packages/core/src/media/recipe.ts");
    expect(resolvePath("gc.ts", "packages/core/src/media", entries)).toBe("packages/core/src/gc.ts");
    expect(resolvePath("media/recipe.ts", "", entries)).toBe("packages/core/src/media/recipe.ts");
    expect(resolvePath("media/", "", entries)).toBe("packages/core/src/media/");
  });

  it("returns null for a path nothing ends with", () => {
    expect(resolvePath("media/recipes.ts", "packages/core/src", entries)).toBeNull();
  });
});

describe("rule keys", () => {
  const old = "| Words | `placeWords` in `timeline-words.ts`, never a second placer; tuning (read-only; never sets a constant) |";

  it("keys a rule on its polarity word and the nearest backticked span or words", () => {
    expect(ruleKeys(old).map(ruleId)).toEqual(["rule: never timeline-words.ts + placeWords", "rule: only read-only", "rule: never constant"]);
  });

  it("keeps a rule moved to another file line, and loses it without its polarity word", () => {
    const [placer, , constant] = ruleKeys(old);
    expect(ruleKept(placer, ["- One placer `placeWords` (`transcripts/timeline-words.ts`); never a second placer."])).toBe(true);
    expect(ruleKept(placer, ["- One placer `placeWords` (`transcripts/timeline-words.ts`)."])).toBe(false);
    expect(ruleKept(constant, ["`people tune` = read-only; never sets a CONSTANT."])).toBe(true);
    expect(ruleKept(constant, ["`people tune` = read-only.", "never"])).toBe(false);
  });
});

describe("tokensOf", () => {
  it("collects spans, ADRs, issues, env vars, pnpm commands and constants", () => {
    const tokens = tokensOf("See ADR 0032 (#457): `matte.prepare`, FRAMESHELL_MATTE_STAND_IN=1, run pnpm gen:skill, bump RECIPE_VERSION.");
    expect(tokens).toEqual(expect.arrayContaining(["matte.prepare", "ADR 0032", "#457", "FRAMESHELL_MATTE_STAND_IN", "pnpm gen:skill", "RECIPE_VERSION"]));
  });
});

describe("repo CLAUDE.md files", () => {
  it("sit outside shipped dirs and name existing paths", () => {
    expect(() => execFileSync(process.execPath, ["scripts/claude-md-check.mjs"], { encoding: "utf8" })).not.toThrow();
  });
});
