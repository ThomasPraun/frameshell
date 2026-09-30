import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractZip } from "../src/binaries/unzip.js";
import { zip } from "./archives.js";
import { tempDir } from "./helpers.js";

// Linux has no zip-capable system tar; Chrome for Testing ships only zips. This reader extracts them.
function archiveFile(entries: Parameters<typeof zip>[0], deflate = true): string {
  const file = join(tempDir(), "archive.zip");
  writeFileSync(file, zip(entries, { deflate }));
  return file;
}

describe("zip extraction", () => {
  it("extracts the named members and every file under a named directory, deflated or stored, keeping exec bits", async () => {
    for (const deflate of [true, false]) {
      const archive = archiveFile(
        {
          "top/bin/tool": { content: "tool-bytes".repeat(1000), mode: 0o755 },
          "top/data/a.pak": { content: "a", mode: 0o644 },
          "top/data/deep/b.pak": { content: "b", mode: 0o644 },
          "other/skip.txt": { content: "no", mode: 0o644 },
          "top-sibling/skip.txt": { content: "no", mode: 0o644 },
        },
        deflate,
      );
      const dest = tempDir();
      await extractZip(archive, dest, ["top/bin/tool", "top/data"]);
      expect(readFileSync(join(dest, "top", "bin", "tool"), "utf8")).toBe("tool-bytes".repeat(1000));
      expect(readFileSync(join(dest, "top", "data", "deep", "b.pak"), "utf8")).toBe("b");
      expect(readdirSync(dest)).toEqual(["top"]);
      if (process.platform !== "win32") expect(statSync(join(dest, "top", "bin", "tool")).mode & 0o777).toBe(0o755);
    }
  });

  it("fails naming a member the archive lacks", async () => {
    const archive = archiveFile({ "top/tool": { content: "x" } });
    await expect(extractZip(archive, tempDir(), ["top/missing"])).rejects.toThrow(/top\/missing/);
  });

  it("refuses entries that would land outside the destination", async () => {
    const archive = archiveFile({ "../escape.txt": { content: "x" } });
    const dest = tempDir();
    await expect(extractZip(archive, join(dest, "inner"), ["../escape.txt"])).rejects.toThrow(/outside/);
    expect(existsSync(join(dest, "escape.txt"))).toBe(false);
  });
});
