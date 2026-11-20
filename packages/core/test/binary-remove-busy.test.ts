import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { BinaryManager, currentPlatform } from "../src/index.js";
import { tempDir } from "./helpers.js";

// A program running from the install makes Windows refuse to rename its directory.
const locked = vi.hoisted(() => ({ on: true }));
vi.mock("../src/fs-util.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/fs-util.js")>();
  return {
    ...original,
    renameRetrying: async (from: string, to: string) => {
      if (locked.on && to.includes(".removing-")) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return original.renameRetrying(from, to);
    },
  };
});

describe("BinaryManager removal while files are open", () => {
  it("refuses and leaves the install whole, then removes once nothing holds it", async () => {
    const dataDir = tempDir();
    const binaries = new BinaryManager({
      dataDir,
      configDir: tempDir(),
      packages: [{ name: "tools", tools: ["alpha"], builds: { [currentPlatform()]: { version: "1.2.3", origin: "https://example.test", license: "MIT", archives: [] } } }],
    });
    const install = join(dataDir, "binaries", "tools", "1.2.3", currentPlatform());
    mkdirSync(install, { recursive: true });
    for (const file of ["install.json", "alpha", "lib.dll"]) writeFileSync(join(install, file), file);

    // EPERM means open files only on Windows; elsewhere it is a permission problem.
    const refusal =
      process.platform === "win32"
        ? { code: ErrorCode.BinaryInUse, data: { name: "tools", reason: "files-open" } }
        : { message: expect.stringContaining("no permission") };
    await expect(binaries.remove("tools")).rejects.toMatchObject(refusal);
    expect(readdirSync(install).sort()).toEqual(["alpha", "install.json", "lib.dll"]);
    expect(readdirSync(join(dataDir, "binaries"))).toEqual(["tools"]);

    locked.on = false;
    expect(await binaries.remove("tools")).toMatchObject({ removed: true, versions: ["1.2.3"] });
    expect(existsSync(join(dataDir, "binaries", "tools"))).toBe(false);
    expect(readdirSync(join(dataDir, "binaries"))).toEqual([]);
  });
});
