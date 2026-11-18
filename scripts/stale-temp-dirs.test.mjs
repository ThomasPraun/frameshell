import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_TEMP_MS, sweepStaleTempDirs } from "./stale-temp-dirs.mjs";

const now = Date.now();
const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "sweep-test-"));
  roots.push(root);
  return root;
}

function entry(root, name, ageMs) {
  const path = join(root, name);
  mkdirSync(path);
  writeFileSync(join(path, "inner.txt"), "x");
  const when = new Date(now - ageMs);
  utimesSync(path, when, when);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sweepStaleTempDirs", () => {
  it("removes a dir with the prefix older than the stale age and keeps fresh ones and other prefixes", async () => {
    const root = makeRoot();
    const old = entry(root, "fse-old", STALE_TEMP_MS + 60_000);
    const fresh = entry(root, "fse-fresh", 60_000);
    const other = entry(root, "other-old", STALE_TEMP_MS + 60_000);

    expect(await sweepStaleTempDirs(root, "fse-", now)).toEqual(["fse-old"]);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("takes the stale age from the argument", async () => {
    const root = makeRoot();
    const path = entry(root, "fse-a", 5_000);
    expect(await sweepStaleTempDirs(root, "fse-", now, 10_000)).toEqual([]);
    expect(await sweepStaleTempDirs(root, "fse-", now, 1_000)).toEqual(["fse-a"]);
    expect(existsSync(path)).toBe(false);
  });

  it("does nothing when the directory is missing", async () => {
    expect(await sweepStaleTempDirs(join(makeRoot(), "none"), "fse-", now)).toEqual([]);
  });
});
