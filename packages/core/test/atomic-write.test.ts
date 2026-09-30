import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeTextAtomic } from "../src/fs-util.js";
import { tempDir } from "./helpers.js";

// Windows refuses to replace a file another handle has open (EPERM): a reader, a watcher, antivirus.
// Elsewhere these pass trivially; the Windows CI job is the one that proves them.
describe("writeTextAtomic", () => {
  it("replaces a target another handle holds open, once that handle closes", async () => {
    const path = join(tempDir(), "main.json");
    writeFileSync(path, "old");
    const reader = await open(path, "r");
    const released = new Promise<void>((resolve) => setTimeout(() => void reader.close().then(resolve), 300));
    await writeTextAtomic(path, "new");
    await released;
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps writing while readers keep reading the target", async () => {
    const dir = tempDir();
    const path = join(dir, "main.json");
    writeFileSync(path, "0");
    let writing = true;
    const readers = Array.from({ length: 4 }, async () => {
      while (writing) await readFile(path, "utf8");
    });
    try {
      for (let i = 1; i <= 50; i++) await writeTextAtomic(path, String(i));
    } finally {
      writing = false;
      await Promise.all(readers);
    }
    expect(readFileSync(path, "utf8")).toBe("50");
    expect(readdirSync(dir)).toEqual(["main.json"]);
  });

  it("lets concurrent writes of one path each land whole, leaving no temp file", async () => {
    const dir = tempDir();
    const path = join(dir, "main.json");
    const contents = Array.from({ length: 8 }, (_, i) => `v${i}`.repeat(1000));
    await Promise.all(contents.map((content) => writeTextAtomic(path, content)));
    expect(contents).toContain(readFileSync(path, "utf8"));
    expect(readdirSync(dir)).toEqual(["main.json"]);
  });
});
