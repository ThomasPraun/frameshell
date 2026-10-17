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

  it("defaults the daemon socket only when the caller sets none", async () => {
    const withSocket = { ...target, socket: "/var/folders/x y/T/frameshelld-501.sock" };
    const script = cliShimScript(withSocket, "darwin");
    expect(parseCliShim(script)).toEqual(withSocket);
    // POSIX shims only run under a POSIX shell.
    if (process.platform === "win32") return;
    const { execFileSync } = await import("node:child_process");
    const run = (env: Record<string, string>) =>
      execFileSync("/bin/sh", ["-c", `${script.split("\n").slice(1, 3).join("\n")}\nprintf %s "$FRAMESHELL_SOCKET"`], { env }).toString();
    expect(run({})).toBe("/var/folders/x y/T/frameshelld-501.sock");
    expect(run({ FRAMESHELL_SOCKET: "/tmp/fs-test.sock" })).toBe("/tmp/fs-test.sock");
  });

  it("returns null for any other command file", () => {
    expect(parseCliShim('#!/bin/sh\nexec "/usr/bin/node" "/x/frameshell.js" "$@"\n')).toBeNull();
    // npm's Windows wrapper: no ELECTRON_RUN_AS_NODE.
    expect(parseCliShim('@ECHO off\r\n"node" "C:\\npm\\node_modules\\@frameshell\\cli\\dist\\bin\\frameshell.js" %*\r\n')).toBeNull();
    expect(parseCliShim("\u007fELF\u0002\u0001")).toBeNull();
  });
});
