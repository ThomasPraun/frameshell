import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { BinaryManager, currentPlatform } from "../src/index.js";
import { tempDir } from "./helpers.js";

// Windows refuses to rename a directory that a running process uses as its working directory.
describe.skipIf(process.platform !== "win32")("BinaryManager removal against a real lock", () => {
  it("refuses with files-open while a process runs inside the install, then removes it once the process ends", async () => {
    const dataDir = tempDir();
    const binaries = new BinaryManager({
      dataDir,
      configDir: tempDir(),
      packages: [{ name: "tools", tools: ["alpha"], builds: { [currentPlatform()]: { version: "1.2.3", origin: "https://example.test", license: "MIT", archives: [] } } }],
    });
    const install = join(dataDir, "binaries", "tools", "1.2.3", currentPlatform());
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, "alpha"), "alpha");

    const child = spawn(process.execPath, ["-e", "process.stdout.write('up'); process.stdin.resume()"], { cwd: install, stdio: ["pipe", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
      });
      await expect(binaries.remove("tools")).rejects.toMatchObject({ code: ErrorCode.BinaryInUse, data: { name: "tools", reason: "files-open" } });
      expect(existsSync(join(install, "alpha"))).toBe(true);
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    expect(await binaries.remove("tools")).toMatchObject({ removed: true });
    expect(existsSync(join(dataDir, "binaries", "tools"))).toBe(false);
  });
});
