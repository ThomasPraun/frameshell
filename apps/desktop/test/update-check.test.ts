import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { mismatchPid, stopStaleDaemon, stoppable, versionChanged } from "../src/main/stale-daemon.js";
import { DOWNLOAD_PAGE, UpdatePreferences, compareVersions, isNewer, releaseFromGitHub, updateMode } from "../src/main/update-check.js";

const socketPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-stale-test-${randomUUID().slice(0, 8)}`
    : join(mkdtempSync(join(tmpdir(), "fs-stale-")), "d.sock");
const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), "frameshell-updates-")), name);

describe("compareVersions", () => {
  it("orders by semver, prereleases before their release", () => {
    const sorted = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(compareVersions(sorted[i]!, sorted[i + 1]!)).toBeLessThan(0);
      expect(compareVersions(sorted[i + 1]!, sorted[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("refuses what is not semver", () => {
    expect(compareVersions("1.2", "1.2.0")).toBeNull();
    expect(isNewer("latest", "0.1.0")).toBe(false);
  });

  it("isNewer only for a strictly newer version", () => {
    expect(isNewer("0.8.0", "0.7.3")).toBe(true);
    expect(isNewer("0.8.0", "0.8.0")).toBe(false);
    expect(isNewer("0.8.0", "0.8.0-beta.1")).toBe(true);
    expect(isNewer("0.7.9", "0.8.0")).toBe(false);
  });
});

describe("updateMode", () => {
  const release = { packaged: true, version: "0.8.0", env: {} };

  it("installs on macOS and from an AppImage, notifies on Windows and for the .deb", () => {
    expect(updateMode({ ...release, platform: "darwin" })).toBe("auto");
    expect(updateMode({ ...release, platform: "linux", env: { APPIMAGE: "/home/ana/Frameshell.AppImage" } })).toBe("auto");
    expect(updateMode({ ...release, platform: "linux" })).toBe("notify");
    expect(updateMode({ ...release, platform: "win32" })).toBe("notify");
  });

  it("never checks in dev, CI or local builds unless forced", () => {
    expect(updateMode({ ...release, platform: "darwin", packaged: false })).toBe("off");
    expect(updateMode({ ...release, platform: "darwin", version: "0.0.0-ci.42" })).toBe("off");
    expect(updateMode({ ...release, platform: "win32", version: "0.0.0-local" })).toBe("off");
    expect(updateMode({ ...release, platform: "darwin", packaged: false, env: { FRAMESHELL_UPDATE_CHECK: "1" } })).toBe("notify");
    expect(updateMode({ ...release, platform: "darwin", version: "0.0.0-ci.42", env: { FRAMESHELL_UPDATE_CHECK: "1" } })).toBe("auto");
  });

  it("FRAMESHELL_UPDATE_CHECK=0 turns a release build off", () => {
    expect(updateMode({ ...release, platform: "darwin", env: { FRAMESHELL_UPDATE_CHECK: "0" } })).toBe("off");
  });
});

describe("releaseFromGitHub", () => {
  it("reads the tag and the release page", () => {
    const page = "https://github.com/ThomasPraun/frameshell/releases/tag/v0.8.0";
    expect(releaseFromGitHub({ tag_name: "v0.8.0", html_url: page, draft: false, prerelease: false })).toEqual({ version: "0.8.0", url: page });
  });

  it("links the download page when the page is not on github.com", () => {
    expect(releaseFromGitHub({ tag_name: "v0.8.0", html_url: "https://example.com/x" })?.url).toBe(DOWNLOAD_PAGE);
  });

  it("ignores drafts, prereleases and other tags", () => {
    expect(releaseFromGitHub({ tag_name: "v0.8.0", draft: true })).toBeNull();
    expect(releaseFromGitHub({ tag_name: "v0.8.0-beta.1", prerelease: true })).toBeNull();
    expect(releaseFromGitHub({ tag_name: "whisper-cpp-v1.0.0" })).toBeNull();
    expect(releaseFromGitHub({ message: "Not Found" })).toBeNull();
    expect(releaseFromGitHub(null)).toBeNull();
  });
});

describe("UpdatePreferences", () => {
  it("checks automatically by default and remembers the opt-out", async () => {
    const file = tempFile("updates.json");
    const preferences = new UpdatePreferences(file);
    await preferences.load();
    expect(preferences.automatic).toBe(true);
    await preferences.setAutomatic(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ automatic: false });
    const again = new UpdatePreferences(file);
    await again.load();
    expect(again.automatic).toBe(false);
  });

  it("falls back to the default on an unreadable file", async () => {
    const file = tempFile("updates.json");
    writeFileSync(file, "{not json");
    const preferences = new UpdatePreferences(file);
    await preferences.load();
    expect(preferences.automatic).toBe(true);
  });
});

describe("stale daemon after an update", () => {
  it("versionChanged is true on the first start of each version", async () => {
    const file = tempFile("last-version");
    expect(await versionChanged(file, "0.8.0")).toBe(true);
    expect(await versionChanged(file, "0.8.0")).toBe(false);
    expect(await versionChanged(file, "0.9.0")).toBe(true);
  });

  it("stops only a daemon nobody else uses and with no pending job", () => {
    expect(stoppable(1, [{ state: "done" }, { state: "failed" }, { state: "canceled" }])).toBe(true);
    expect(stoppable(2, [])).toBe(false);
    expect(stoppable(1, [{ state: "running" }])).toBe(false);
    expect(stoppable(1, [{ state: "queued" }])).toBe(false);
  });

  it("gives up on a daemon that never answers within its budget and stops nothing", async () => {
    const path = socketPath();
    const held: Socket[] = [];
    const server = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const killed: number[] = [];
      const started = Date.now();
      const outcome = await stopStaleDaemon({ socketPath: path, client: "test", cwd: tmpdir(), kill: (pid) => killed.push(pid), timeoutMs: 300 });
      expect(outcome).toBe("kept");
      expect(Date.now() - started).toBeLessThan(1500);
      expect(killed).toEqual([]);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports no daemon when nobody listens", async () => {
    expect(await stopStaleDaemon({ socketPath: socketPath(), client: "test", cwd: tmpdir(), timeoutMs: 300 })).toBe("none");
  });

  it("reads the pid of a daemon speaking another protocol", () => {
    const message =
      "Protocol mismatch: client speaks v35, frameshelld 0.0.0 (pid 4242) speaks v34. Upgrade frameshelld so both match.";
    expect(mismatchPid(new RpcError(ErrorCode.IncompatibleProtocol, message))).toBe(4242);
    expect(mismatchPid(new RpcError(ErrorCode.InternalError, message))).toBeNull();
    expect(mismatchPid(new Error(message))).toBeNull();
  });
});
