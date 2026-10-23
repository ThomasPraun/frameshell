import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewSwitch, reviewKey } from "../src/proposals/review-switch.js";
import { tempDir } from "./helpers.js";

describe("reviewKey", () => {
  it("gives every Windows spelling of one root the same key", () => {
    const spellings = ["C:\\Users\\Ana\\promo", "c:\\users\\ana\\promo", "C:/Users/Ana/promo", "C:\\Users\\Ana\\promo\\", "c:/USERS/ana/promo/"];
    expect(new Set(spellings.map((root) => reviewKey(root, "win32")))).toEqual(new Set(["c:\\users\\ana\\promo"]));
    expect(reviewKey("C:\\", "win32")).toBe("c:\\");
  });

  it("keeps POSIX roots as they are: case matters there", () => {
    expect(reviewKey("/home/Ana/promo", "linux")).toBe("/home/Ana/promo");
    expect(reviewKey("/Users/Ana/promo", "darwin")).not.toBe(reviewKey("/users/ana/promo", "darwin"));
  });
});

describe("ReviewSwitch", () => {
  it("reads a stored key in any spelling the platform treats as the same root", async () => {
    const configDir = tempDir();
    const root = process.platform === "win32" ? "C:\\Work\\Promo" : "/work/promo";
    const stored = process.platform === "win32" ? "c:/work/promo/" : root;
    writeFileSync(join(configDir, "review.json"), JSON.stringify({ version: 1, projects: { [stored]: { enabled: true, since: "2026-10-22T00:00:00Z" } } }));
    const review = new ReviewSwitch({ dataDir: tempDir(), configDir });
    expect(await review.enabled(root)).toBe(true);
    await review.set(root, false);
    expect(await review.enabled(root)).toBe(false);
    expect(await new ReviewSwitch({ dataDir: tempDir(), configDir }).enabled(root)).toBe(false);
  });
});
