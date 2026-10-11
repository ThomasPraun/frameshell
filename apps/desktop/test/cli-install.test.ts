import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CliInstallHost,
  addPathEntry,
  cliInstallBlocker,
  cliLinkDir,
  installCli,
  removePathEntry,
  uninstallCli,
} from "../src/main/cli-install.js";

// Seam under test: the File menu's install of the system-wide `frameshell` (#139), against a temp dir for the link
// and a fake host for prompts and the Windows registry.

function setup(platform: NodeJS.Platform = "linux") {
  const root = mkdtempSync(join(tmpdir(), "frameshell-cli-install-"));
  const shim = join(root, "data", "desktop", "bin", "frameshell");
  mkdirSync(join(root, "data", "desktop", "bin"), { recursive: true });
  writeFileSync(shim, "#!/bin/sh\n");
  const linkDir = join(root, "home", ".local", "bin");
  const calls = { confirm: [] as string[], admin: [] as string[] };
  let userPath = "C:\\Windows;%USERPROFILE%\\bin";
  const host: CliInstallHost = {
    platform,
    linkDir,
    path: "/usr/bin:/bin",
    confirmReplace: async (link) => {
      calls.confirm.push(link);
      return true;
    },
    runAsAdmin: async (script) => {
      calls.admin.push(script);
    },
    readUserPath: async () => userPath,
    writeUserPath: async (value) => {
      userPath = value;
    },
  };
  return { root, shim, link: join(linkDir, "frameshell"), host, calls, userPath: () => userPath };
}

describe("installCli (macOS, Linux)", () => {
  it("links the shim, warns on Linux when the dir is off PATH, and is idempotent", async () => {
    const { shim, link, host } = setup();
    const first = await installCli(shim, host);
    expect(readlinkSync(link)).toBe(shim);
    expect(first).toMatchObject({ changed: true, detail: expect.stringContaining("not on your PATH") });
    expect(await installCli(shim, { ...host, path: `/usr/bin:${host.linkDir}` })).toMatchObject({ changed: false });
  });

  it("repoints a link to another build's shim of the same data dir without asking", async () => {
    const { root, shim, link, host, calls } = setup();
    mkdirSync(host.linkDir!, { recursive: true });
    symlinkSync(join(root, "data", "desktop", "bin-dev", "frameshell"), link);
    expect(await installCli(shim, host)).toMatchObject({ changed: true });
    expect(readlinkSync(link)).toBe(shim);
    expect(calls.confirm).toEqual([]);
  });

  it("asks before replacing another install's command, and keeps it on no", async () => {
    const { shim, link, host, calls } = setup();
    mkdirSync(host.linkDir!, { recursive: true });
    symlinkSync("/opt/node/lib/node_modules/@frameshell/cli/dist/bin/frameshell.js", link);
    const declined = await installCli(shim, { ...host, confirmReplace: async () => false });
    expect(declined.changed).toBe(false);
    expect(readlinkSync(link)).toContain("node_modules");
    await installCli(shim, host);
    expect(calls.confirm).toEqual([link]);
    expect(readlinkSync(link)).toBe(shim);
  });

  it("never replaces a regular file", async () => {
    const { shim, link, host } = setup();
    mkdirSync(host.linkDir!, { recursive: true });
    writeFileSync(link, "#!/bin/sh\n");
    await expect(installCli(shim, host)).rejects.toThrow("is not a link");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "on macOS, falls back to the admin prompt when the dir is not writable",
    async () => {
      const { shim, host, calls } = setup("darwin");
      mkdirSync(host.linkDir!, { recursive: true });
      chmodSync(host.linkDir!, 0o555);
      try {
        expect(await installCli(shim, host)).toMatchObject({ changed: true });
        expect(calls.admin).toEqual([
          `mkdir -p '${host.linkDir}' && ln -sfn '${shim}' '${join(host.linkDir!, "frameshell")}'`,
        ]);
      } finally {
        chmodSync(host.linkDir!, 0o755);
      }
    },
  );

  it("on Linux, reports a non-writable dir instead of prompting", async () => {
    const { shim, host, calls } = setup("linux");
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    mkdirSync(host.linkDir!, { recursive: true });
    chmodSync(host.linkDir!, 0o555);
    try {
      await expect(installCli(shim, host)).rejects.toThrow();
      expect(calls.admin).toEqual([]);
    } finally {
      chmodSync(host.linkDir!, 0o755);
    }
  });
});

describe("uninstallCli (macOS, Linux)", () => {
  it("removes only a link to this app's shim", async () => {
    const { shim, link, host } = setup();
    expect(await uninstallCli(shim, host)).toMatchObject({ changed: false, message: expect.stringContaining("No") });
    mkdirSync(host.linkDir!, { recursive: true });
    symlinkSync("/opt/elsewhere/frameshell", link);
    expect(await uninstallCli(shim, host)).toMatchObject({ changed: false });
    expect(existsSync(link) || lstatSync(link).isSymbolicLink()).toBe(true);

    await installCli(shim, { ...host, confirmReplace: async () => true });
    expect(await uninstallCli(shim, host)).toMatchObject({ changed: true });
    expect(() => lstatSync(link)).toThrow();
  });
});

describe("installCli (Windows)", () => {
  it("adds the shim's dir to the user PATH once, and uninstall removes it", async () => {
    const { host, userPath } = setup("win32");
    const shim = "C:\\Users\\Ana\\AppData\\Local\\frameshell\\desktop\\bin\\frameshell.cmd";
    const dir = "C:\\Users\\Ana\\AppData\\Local\\frameshell\\desktop\\bin";
    expect(await installCli(shim, host)).toMatchObject({ changed: true, detail: expect.stringContaining("new one") });
    expect(userPath()).toBe(`C:\\Windows;%USERPROFILE%\\bin;${dir}`);
    expect(await installCli(shim, host)).toMatchObject({ changed: false });
    expect(await uninstallCli(shim, host)).toMatchObject({ changed: true });
    expect(userPath()).toBe("C:\\Windows;%USERPROFILE%\\bin");
  });
});

describe("PATH entries", () => {
  it("compare case-insensitively and ignore a trailing backslash", () => {
    expect(addPathEntry("C:\\A;c:\\bin\\", "C:\\Bin")).toBe("C:\\A;c:\\bin\\");
    expect(addPathEntry("", "C:\\Bin")).toBe("C:\\Bin");
    expect(addPathEntry("C:\\A;", "C:\\Bin")).toBe("C:\\A;C:\\Bin");
    expect(removePathEntry("C:\\A;c:\\bin\\;C:\\B", "C:\\Bin")).toBe("C:\\A;C:\\B");
    expect(removePathEntry("C:\\A;;C:\\B", "C:\\Bin")).toBe("C:\\A;;C:\\B");
  });
});

describe("cliLinkDir and cliInstallBlocker", () => {
  it("picks /usr/local/bin on macOS, ~/.local/bin on Linux, none on Windows", () => {
    expect(cliLinkDir("darwin", "/Users/ana")).toBe("/usr/local/bin");
    expect(cliLinkDir("linux", "/home/ana")).toBe("/home/ana/.local/bin");
    expect(cliLinkDir("win32", "C:\\Users\\ana")).toBeUndefined();
  });

  it("blocks app copies that run from a temporary path", () => {
    const mac = "/Applications/Frameshell.app/Contents/MacOS/Frameshell";
    expect(cliInstallBlocker("darwin", mac, {})).toBeUndefined();
    expect(cliInstallBlocker("darwin", "/Volumes/Frameshell 0.3.0/Frameshell.app/Contents/MacOS/Frameshell", {})).toMatch(
      "Applications",
    );
    expect(
      cliInstallBlocker("darwin", "/private/var/folders/x/AppTranslocation/1/d/Frameshell.app/Contents/MacOS/Frameshell", {}),
    ).toMatch("Applications");
    expect(cliInstallBlocker("linux", "/tmp/.mount_x/frameshell", { APPIMAGE: "/home/a/F.AppImage" })).toMatch(".deb");
    expect(cliInstallBlocker("linux", "/opt/Frameshell/frameshell", {})).toBeUndefined();
  });
});
