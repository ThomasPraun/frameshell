import { describe, expect, it } from "vitest";
import { testScope } from "./test-scope.mjs";

describe("testScope", () => {
  it("runs nothing for docs, website, evals and root markdown", () => {
    expect(testScope(["docs/adr/0040-batch.md", "website/src/index.astro", "CHANGELOG.md", "evals/x/README.md"])).toEqual(
      { unit: "none", filter: [], e2e: false },
    );
  });

  it("runs everything when a package, skill, script, config or unknown path changes", () => {
    for (const path of [
      "packages/protocol/src/methods.ts",
      "skills/frameshell/SKILL.md",
      "scripts/plugins-npm.mjs",
      "pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      "packages/core/CLAUDE.md",
      ".gitignore",
    ]) {
      expect(testScope(["apps/desktop/src/main/index.ts", path]), path).toEqual({ unit: "all", filter: [], e2e: true });
    }
  });

  it("runs the desktop tests and e2e for an app change", () => {
    expect(testScope(["apps/desktop/src/renderer/src/App.tsx", "docs/SPEC.md"])).toEqual({
      unit: "some",
      filter: ["apps/desktop/test"],
      e2e: true,
    });
  });

  it("runs a plugin's tests plus the tests that read plugin files", () => {
    expect(testScope(["plugins\\remotion\\src\\adapter.ts"])).toEqual({
      unit: "some",
      filter: [
        "apps/desktop/test/whisper-default-model.test.ts",
        "packages/cli/test/skill-docs.test.ts",
        "packages/core/test/official-plugin-packages.test.ts",
        "plugins/remotion/test",
      ],
      e2e: true,
    });
  });

  it("drops the desktop plugin reader when all desktop tests run", () => {
    expect(testScope(["plugins/blender/src/a.ts", "apps/desktop/e2e/x.spec.ts"]).filter).toEqual([
      "apps/desktop/test",
      "packages/cli/test/skill-docs.test.ts",
      "packages/core/test/official-plugin-packages.test.ts",
      "plugins/blender/test",
    ]);
  });
});
