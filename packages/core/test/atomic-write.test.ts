import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeTextAtomic } from "../src/fs-util.js";
import { tempDir } from "./helpers.js";

// Windows refuses to replace a file another handle has open (EPERM): a reader, a watcher, antivirus.
// Elsewhere the first two pass trivially; the Windows CI job is the one that proves them.
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

  // A reader parses what it read before it reads again, so there is a moment with no handle open. A reader
  // that reopens in the same tick would hold the target for good and starve any rename on Windows.
  it("keeps writing while a reader keeps reading the target (the daemon's own reads, a client's)", async () => {
    const dir = tempDir();
    const path = join(dir, "main.json");
    const whole = (i: number) => String(i % 10).repeat(20_000);
    writeFileSync(path, whole(0));
    let writing = true;
    let reads = 0;
    const torn: string[] = [];
    const reader = (async () => {
      while (writing) {
        const text = await readFile(path, "utf8");
        reads++;
        if (text.length !== 20_000 || !/^(\d)\1*$/.test(text)) torn.push(text.slice(0, 20));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      for (let i = 1; i <= 50; i++) await writeTextAtomic(path, whole(i));
    } finally {
      writing = false;
      await reader;
    }
    expect(reads).toBeGreaterThan(0);
    expect(torn).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(whole(50));
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
