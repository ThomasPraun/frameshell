import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyContext, writeContext } from "../src/context.js";
import { tempDir } from "./helpers.js";

// Seam under test: the Ask agent details files the daemon writes for the app (ADR 0011, `context.write`).

describe("writeContext", () => {
  it("writes the details file under .frameshell/context, creating the folder", async () => {
    const root = tempDir();
    expect(await writeContext(root, "e_0421_1.json", '{"kind":"point"}\n')).toEqual({ path: ".frameshell/context/e_0421_1.json" });
    expect(readFileSync(join(root, ".frameshell", "context", "e_0421_1.json"), "utf8")).toBe('{"kind":"point"}\n');
  });

  it("refuses a context folder that leads out of the project", async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    mkdirSync(join(root, ".frameshell"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".frameshell", "context"), "dir");
    await expect(writeContext(root, "e_0001_1.json", "{}")).rejects.toThrow(/outside the project/);
  });
});

describe("classifyContext", () => {
  it("knows frame captures and details files, nothing else", () => {
    expect(classifyContext("f_0421.png", false)).toEqual({ kind: "context", key: "f_0421.png" });
    expect(classifyContext("e_0421_12.json", false)).toEqual({ kind: "context", key: "e_0421_12.json" });
    expect(classifyContext("m_0421_1210_1530_3.png", false)).toEqual({ kind: "context", key: "m_0421_1210_1530_3.png" });
    expect(classifyContext("m_0421_1210_1530_4.png", false)).toBeNull();
    expect(classifyContext("notes.txt", false)).toBeNull();
    expect(classifyContext("e_0421_1.json", true)).toBeNull();
  });
});
