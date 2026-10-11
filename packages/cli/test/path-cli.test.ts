import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliShimName, cliShimScript } from "@frameshell/protocol";
import { describeCliPackage, inspectPathCli } from "../src/path-cli.js";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-path-cli-")));

/** A CLI package with its entry; inside a desktop app's `node_modules` when `app` gives the app's version. */
function cliPackage(root: string, app?: string): string {
  if (app) writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@frameshell/desktop", version: app }));
  const dir = app ? join(root, "node_modules", "@frameshell", "cli") : root;
  mkdirSync(join(dir, "dist", "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@frameshell/cli", version: "0.0.0" }));
  writeFileSync(join(dir, "dist", "bin", "frameshell.js"), "");
  return dir;
}

/** An app shim for `cliDir` in a new PATH directory; returns that directory. */
function shim(cliDir: string, platform: NodeJS.Platform = process.platform, runtime = process.execPath): string {
  const bin = tempDir();
  const file = join(bin, cliShimName(platform));
  writeFileSync(file, cliShimScript({ runtime, cliEntry: join(cliDir, "dist", "bin", "frameshell.js") }, platform));
  chmodSync(file, 0o755);
  return bin;
}

describe("describeCliPackage", () => {
  it("takes the app's version for a CLI bundled in the desktop app, the package's otherwise", () => {
    expect(describeCliPackage(cliPackage(tempDir(), "0.3.0"))).toMatchObject({ version: "0.3.0", app: true });
    const plain = cliPackage(tempDir());
    expect(describeCliPackage(plain)).toEqual({ entry: join(plain, "dist", "bin", "frameshell.js"), version: "0.0.0", app: false });
  });
});

describe.skipIf(process.platform === "win32")("inspectPathCli", () => {
  const self = describeCliPackage(cliPackage(tempDir(), "0.3.0"));
  const selfDir = join(self.entry, "..", "..", "..");

  it("without a frameshell on PATH, points at the app's menu", () => {
    const report = inspectPathCli(self, { PATH: tempDir() });
    expect(report).toMatchObject({ path: null, cli: null, same: false });
    expect(report.notes).toEqual([expect.stringContaining("File → Install 'frameshell' Command in PATH")]);
  });

  it("recognizes this CLI behind a link to its app shim, with no notes", () => {
    const bin = shim(selfDir);
    const linkDir = tempDir();
    symlinkSync(join(bin, "frameshell"), join(linkDir, "frameshell"));
    const report = inspectPathCli(self, { PATH: `${tempDir()}:${linkDir}:${bin}` });
    expect(report).toMatchObject({ path: join(linkDir, "frameshell"), target: join(bin, "frameshell"), same: true, notes: [] });
    expect(report.cli).toEqual(self);
  });

  it("names another app's CLI and both versions when they differ", () => {
    const other = cliPackage(tempDir(), "0.2.0");
    const report = inspectPathCli(self, { PATH: shim(other) });
    expect(report).toMatchObject({ same: false, cli: { app: true, version: "0.2.0" } });
    expect(report.notes).toEqual(["`frameshell` on PATH runs Frameshell app 0.2.0, not this CLI (Frameshell app 0.3.0). Versions differ: 0.2.0 on PATH, 0.3.0 here."]);
  });

  it("flags a shim whose app is gone", () => {
    const report = inspectPathCli(self, { PATH: shim(selfDir, process.platform, "/Applications/Gone.app/Contents/MacOS/Frameshell") });
    expect(report.notes).toEqual([expect.stringMatching(/runs a Frameshell app that is gone \(\/Applications\/Gone\.app\/Contents\/MacOS\/Frameshell is missing\)\. Reinstall it/)]);
  });

  it("follows an npm link to a CLI package, and says when a command is not Frameshell's", () => {
    const npm = cliPackage(tempDir());
    const bin = tempDir();
    symlinkSync(join(npm, "dist", "bin", "frameshell.js"), join(bin, "frameshell"));
    chmodSync(join(npm, "dist", "bin", "frameshell.js"), 0o755);
    const linked = inspectPathCli(self, { PATH: bin });
    expect(linked.cli).toEqual({ entry: join(npm, "dist", "bin", "frameshell.js"), version: "0.0.0", app: false });
    expect(linked.notes).toEqual([`\`frameshell\` on PATH runs CLI 0.0.0 at ${linked.cli!.entry}, not this CLI (Frameshell app 0.3.0). Versions differ: 0.0.0 on PATH, 0.3.0 here.`]);

    const custom = tempDir();
    writeFileSync(join(custom, "frameshell"), '#!/bin/sh\nexec node /somewhere/cli.js "$@"\n');
    chmodSync(join(custom, "frameshell"), 0o755);
    const unknown = inspectPathCli(self, { PATH: custom });
    expect(unknown).toMatchObject({ cli: null, same: false });
    expect(unknown.notes).toEqual([`${join(custom, "frameshell")} was not installed by Frameshell and may not be this CLI (Frameshell app 0.3.0).`]);
  });

  it("skips a frameshell that is not executable", () => {
    const bin = tempDir();
    writeFileSync(join(bin, "frameshell"), "");
    expect(inspectPathCli(self, { PATH: bin }).path).toBeNull();
  });
});

/** Writes an asar archive holding `files` (path → text), in the layout Electron reads; returns its path. */
function asar(dir: string, files: Record<string, string>): string {
  const tree: { files: Record<string, unknown> } = { files: {} };
  const data: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    let node = tree;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as typeof tree;
    const bytes = Buffer.from(text);
    node.files[parts.at(-1)!] = { size: bytes.length, offset: String(offset) };
    data.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const payload = 4 + json.length + ((4 - (json.length % 4)) % 4);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(payload + 4, 4);
  prefix.writeUInt32LE(payload, 8);
  prefix.writeUInt32LE(json.length, 12);
  const file = join(dir, "app.asar");
  // Data starts at 8 + header size: right after the JSON, padded to 4 bytes.
  writeFileSync(file, Buffer.concat([prefix, json, Buffer.alloc(payload - 4 - json.length), ...data]));
  return file;
}

describe.skipIf(process.platform === "win32")("inspectPathCli and a packaged app", () => {
  it("reads the app's version and entry inside app.asar, which plain Node cannot open", () => {
    const resources = tempDir();
    const archive = asar(resources, {
      "package.json": JSON.stringify({ name: "@frameshell/desktop", version: "0.3.0" }),
      "node_modules/@frameshell/cli/package.json": JSON.stringify({ name: "@frameshell/cli", version: "0.0.0" }),
      "node_modules/@frameshell/cli/dist/bin/frameshell.js": "",
    });
    const packaged = join(archive, "node_modules", "@frameshell", "cli");
    const self = describeCliPackage(cliPackage(tempDir()));
    const report = inspectPathCli(self, { PATH: shim(packaged) });
    expect(report.cli).toEqual({ entry: join(packaged, "dist", "bin", "frameshell.js"), version: "0.3.0", app: true });
    expect(report.notes).toEqual([expect.stringContaining("runs Frameshell app 0.3.0, not this CLI (CLI 0.0.0 at")]);
  });
});

describe("inspectPathCli on Windows", () => {
  it("finds the app's frameshell.cmd through PATHEXT and reads its target", () => {
    const self = describeCliPackage(cliPackage(tempDir(), "0.3.0"));
    const bin = shim(join(self.entry, "..", "..", ".."), "win32");
    const report = inspectPathCli(self, { Path: `${tempDir()};${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
    expect(report).toMatchObject({ path: join(bin, "frameshell.cmd"), same: true, notes: [] });
  });
});
