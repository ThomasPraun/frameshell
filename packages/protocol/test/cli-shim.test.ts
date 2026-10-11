import { describe, expect, it } from "vitest";
import { cliShimName, cliShimScript, parseCliShim } from "../src/index.js";

describe("cli shim format", () => {
  const target = { runtime: "/Applications/Frame shell.app/Contents/MacOS/Frameshell", cliEntry: "/Users/o'neil/app.asar/node_modules/@frameshell/cli/dist/bin/frameshell.js" };

  it("reads back what it writes, on both platforms, quotes and spaces included", () => {
    expect(parseCliShim(cliShimScript(target, "darwin"))).toEqual(target);
    const windows = { runtime: "C:\\Program Files\\Frameshell\\Frameshell.exe", cliEntry: "C:\\Program Files\\Frameshell\\resources\\app.asar\\node_modules\\@frameshell\\cli\\dist\\bin\\frameshell.js" };
    expect(parseCliShim(cliShimScript(windows, "win32"))).toEqual(windows);
    expect(cliShimName("win32")).toBe("frameshell.cmd");
    expect(cliShimName("linux")).toBe("frameshell");
  });

  it("returns null for any other command file", () => {
    expect(parseCliShim('#!/bin/sh\nexec "/usr/bin/node" "/x/frameshell.js" "$@"\n')).toBeNull();
    // npm's Windows wrapper: no ELECTRON_RUN_AS_NODE.
    expect(parseCliShim('@ECHO off\r\n"node" "C:\\npm\\node_modules\\@frameshell\\cli\\dist\\bin\\frameshell.js" %*\r\n')).toBeNull();
    expect(parseCliShim("\u007fELF\u0002\u0001")).toBeNull();
  });
});
