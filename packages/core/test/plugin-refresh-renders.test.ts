import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlugin } from "../src/plugins/loader.js";
import { tempDir } from "./helpers.js";

/** A plugin that keeps `api.refreshRenders` on `globalThis` under `key`, to call it after `activate`. */
function refreshingPlugin(key: string): string {
  const dir = join(tempDir(), "refresh-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "frameshell-plugin.json"),
    JSON.stringify({ name: "refresh-plugin", version: "0.1.0", apiVersion: "1", main: "index.js", contributes: {} }),
  );
  writeFileSync(join(dir, "index.js"), `export function activate(api) { globalThis[${JSON.stringify(key)}] = () => api.refreshRenders(); }\n`);
  return dir;
}

describe("PluginApi.refreshRenders", () => {
  it("reaches the host's hook after activate, and never throws into the plugin", async () => {
    const key = `__refresh_${Date.now()}`;
    const calls: string[] = [];
    const plugin = await loadPlugin(refreshingPlugin(key), "refresh-plugin", "file:refresh-plugin", "/project", {
      refreshRenders: () => calls.push("refresh"),
    });
    expect(plugin.info.status).toBe("loaded");
    const refresh = (globalThis as Record<string, unknown>)[key] as () => void;
    refresh();
    refresh();
    expect(calls).toEqual(["refresh", "refresh"]);

    const failing = `${key}_failing`;
    await loadPlugin(refreshingPlugin(failing), "refresh-plugin", "file:refresh-plugin#2", "/project", {
      refreshRenders: () => {
        throw new Error("boom");
      },
    });
    expect(() => ((globalThis as Record<string, unknown>)[failing] as () => void)()).not.toThrow();
  });

  it("is a no-op when the host passes no hooks", async () => {
    const key = `__refresh_none_${Date.now()}`;
    await loadPlugin(refreshingPlugin(key), "refresh-plugin", "file:refresh-plugin#3", "/project");
    expect(() => ((globalThis as Record<string, unknown>)[key] as () => void)()).not.toThrow();
  });
});
