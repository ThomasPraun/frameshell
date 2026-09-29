import { describe, expect, it } from "vitest";
import { resolveAppDirs } from "../src/index.js";

// Literal paths are also where earlier releases put binaries (data) and, except
// on Linux, trust (config): installs and decisions are found after an upgrade.
describe("resolveAppDirs", () => {
  it("uses Application Support on macOS for data and config", () => {
    expect(resolveAppDirs({}, "darwin", "/Users/ana")).toEqual({
      dataDir: "/Users/ana/Library/Application Support/Frameshell",
      configDir: "/Users/ana/Library/Application Support/Frameshell",
    });
  });

  it("follows XDG on Linux, with the spec defaults when unset", () => {
    expect(resolveAppDirs({}, "linux", "/home/ana")).toEqual({
      dataDir: "/home/ana/.local/share/frameshell",
      configDir: "/home/ana/.config/frameshell",
    });
    expect(resolveAppDirs({ XDG_DATA_HOME: "/xdg/data", XDG_CONFIG_HOME: "/xdg/config" }, "linux", "/home/ana")).toEqual({
      dataDir: "/xdg/data/frameshell",
      configDir: "/xdg/config/frameshell",
    });
  });

  it("keeps large binaries out of the roaming profile on Windows", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local", APPDATA: "C:\\Users\\ana\\AppData\\Roaming" };
    expect(resolveAppDirs(env, "win32", "C:\\Users\\ana")).toEqual({
      dataDir: "C:\\Users\\ana\\AppData\\Local\\Frameshell",
      configDir: "C:\\Users\\ana\\AppData\\Roaming\\Frameshell",
    });
  });

  it("lets FRAMESHELL_DATA_DIR and FRAMESHELL_CONFIG_DIR win everywhere", () => {
    const env = { FRAMESHELL_DATA_DIR: "/tmp/d", FRAMESHELL_CONFIG_DIR: "/tmp/c", XDG_DATA_HOME: "/xdg" };
    expect(resolveAppDirs(env, "linux", "/home/ana")).toEqual({ dataDir: "/tmp/d", configDir: "/tmp/c" });
  });
});
