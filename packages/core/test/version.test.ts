import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coreVersion } from "../src/version.js";

const files = (entries: Record<string, { name?: string; version?: string }>) => (path: string) => entries[path] ?? null;
const core = join("/app.asar", "node_modules", "@frameshell", "core");

describe("coreVersion (#739)", () => {
  it("reports the packaged app's release version when the core package is the workspace placeholder", () => {
    const read = files({ [join(core, "package.json")]: { version: "0.0.0" }, [join("/app.asar", "package.json")]: { name: "@frameshell/desktop", version: "0.19.0" } });
    expect(coreVersion(core, read)).toBe("0.19.0");
  });

  it("keeps its own version outside an app, or when it has a real one", () => {
    expect(coreVersion(core, files({ [join(core, "package.json")]: { version: "0.0.0" }, [join("/app.asar", "package.json")]: { name: "other", version: "9.9.9" } }))).toBe("0.0.0");
    expect(coreVersion(core, files({ [join(core, "package.json")]: { version: "1.2.3" } }))).toBe("1.2.3");
    expect(coreVersion(core, files({}))).toBe("0.0.0");
  });
});
