import { describe, expect, it } from "vitest";
import { systemErrorText } from "../src/renderer/src/system-error.js";

// #748: Node's file-system errors read as sentences with the path they name; other messages pass through as null.
describe("systemErrorText", () => {
  it("says a known code in words, with its path", () => {
    expect(systemErrorText("EEXIST: file already exists, mkdir '/tmp/out/handoff'")).toBe(
      "Something with that name is already there: /tmp/out/handoff. Pick another name or folder.",
    );
    expect(systemErrorText("Error invoking remote method 'project:new-idea': Error: ENOTDIR: not a directory, mkdir 'C:\\Users\\ana\\film.txt\\Idea'")).toBe(
      "Part of the path is a file, not a folder: C:\\Users\\ana\\film.txt\\Idea. Pick a folder.",
    );
    expect(systemErrorText("EACCES: permission denied, open '/root/x'")).toContain("may not write there: /root/x");
    expect(systemErrorText("EXDEV: cross-device link not permitted, rename '/a' -> '/b'")).toBeNull();
  });

  it("works without a path", () => {
    expect(systemErrorText("ENOSPC: no space left on device, write")).toBe("The disk is full. Free some space, then try again.");
    expect(systemErrorText("EROFS: read-only file system")).toBe("That disk is read-only. Pick a folder on another disk.");
  });

  it("leaves other messages alone", () => {
    expect(systemErrorText("at 3 s is outside timeline main")).toBeNull();
    expect(systemErrorText("ENOTAREALCODE: x")).toBeNull();
  });
});
