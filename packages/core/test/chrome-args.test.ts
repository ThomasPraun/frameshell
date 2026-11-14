import { describe, expect, it } from "vitest";
import { chromeLaunchArgs } from "../src/inspect/chrome.js";

// Seam under test: the command line of the headless Chrome behind `clip.verify`, `inspect.point` and brand capture.

describe("chromeLaunchArgs", () => {
  it("enables SwiftShader so WebGL works without a GPU (ADR 0042)", () => {
    expect(chromeLaunchArgs("/profile")).toContain("--enable-unsafe-swiftshader");
  });

  it("puts the profile and the caller's flags before the start page", () => {
    const args = chromeLaunchArgs("/profile", ["--proxy-server=127.0.0.1:1"], "darwin");
    expect(args).toContain("--user-data-dir=/profile");
    expect(args.slice(-2)).toEqual(["--proxy-server=127.0.0.1:1", "about:blank"]);
  });

  it("turns the sandbox off on Linux only", () => {
    expect(chromeLaunchArgs("/p", [], "linux")).toContain("--no-sandbox");
    expect(chromeLaunchArgs("/p", [], "win32")).not.toContain("--no-sandbox");
  });
});
