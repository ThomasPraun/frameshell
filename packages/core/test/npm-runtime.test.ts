import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { electronNpmEnv, nodeShimScript, npmCliCandidates } from "../src/plugins/npm-runtime.js";

describe("npmCliCandidates", () => {
  it("tries a system Node's npm first, then the npm the app bundles", () => {
    const mac = "/Applications/Frameshell.app/Contents/MacOS";
    expect(npmCliCandidates(mac)).toEqual([
      join(mac, "node_modules/npm/bin/npm-cli.js"),
      join(mac, "../lib/node_modules/npm/bin/npm-cli.js"),
      join("/Applications/Frameshell.app/Contents/Resources/npm/bin/npm-cli.js"),
      join(mac, "resources/npm/bin/npm-cli.js"),
    ]);
  });
});

describe("nodeShimScript", () => {
  it("runs the app's executable as Node, quoting its path", () => {
    expect(nodeShimScript("/opt/Frame's/frameshell", "linux")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/Frame'\\''s/frameshell' "$@"\n`,
    );
    expect(nodeShimScript("C:\\Program Files\\Frameshell\\Frameshell.exe", "win32")).toBe(
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Frameshell\\Frameshell.exe" %*\r\n',
    );
  });
});

describe("electronNpmEnv", () => {
  it("puts a node command first on PATH, keeping Windows' Path key", async () => {
    const env = await electronNpmEnv(process.execPath, { PATH: "/usr/bin" }, "linux");
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    // The temp dir may hold a drive colon (Windows runners): split at the last separator.
    const path = env["PATH"] ?? "";
    expect(path.endsWith(":/usr/bin")).toBe(true);
    const dir = path.slice(0, -":/usr/bin".length);
    expect(readFileSync(join(dir, "node"), "utf8")).toBe(nodeShimScript(process.execPath, "linux"));

    const windows = await electronNpmEnv("C:\\F\\Frameshell.exe", { Path: "C:\\Windows" }, "win32");
    expect(Object.keys(windows).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(windows["Path"]).toMatch(/;C:\\Windows$/);
  });

  it.skipIf(process.platform === "win32")("writes a node command that works", async () => {
    // With a real Node as runtime, ELECTRON_RUN_AS_NODE is ignored and the shim behaves as node.
    const env = await electronNpmEnv(process.execPath, { PATH: "/usr/bin:/bin" });
    const dir = (env["PATH"] ?? "").split(":")[0] ?? "";
    expect(execFileSync(join(dir, "node"), ["-e", "process.stdout.write('ok')"], { encoding: "utf8" })).toBe("ok");
  });
});
