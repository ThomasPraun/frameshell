import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeCliShim } from "../src/main/cli-shim.js";

// The built CLI: `pnpm test` runs `tsc -b` first.
const cliEntry = fileURLToPath(import.meta.resolve("@frameshell/cli/frameshell"));
const cliVersion = (JSON.parse(readFileSync(join(cliEntry, "../../../package.json"), "utf8")) as { version: string })
  .version;

describe("writeCliShim", () => {
  it("writes a `frameshell` command that runs the bundled CLI with the given runtime", async () => {
    const binDir = join(mkdtempSync(join(tmpdir(), "frameshell-shim-")), "bin with space");
    const shim = await writeCliShim(binDir, { runtime: process.execPath, cliEntry });
    // Windows: run the .cmd through cmd.exe, quoted verbatim because the path has a space.
    const result =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${shim}" --version"`], {
            encoding: "utf8",
            windowsVerbatimArguments: true,
          })
        : spawnSync(shim, ["--version"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(cliVersion);
  });

  it("is idempotent", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "frameshell-shim-"));
    const first = await writeCliShim(binDir, { runtime: process.execPath, cliEntry });
    const second = await writeCliShim(binDir, { runtime: process.execPath, cliEntry });
    expect(second).toBe(first);
  });
});
