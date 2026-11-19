import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_PLUGINS, officialPlugin, officialPluginProviding } from "@frameshell/protocol";
import { DEFAULT_TRANSCRIPTION_PROVIDER } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { BLENDER_PACKAGE, DEFAULT_MODELS, DEFAULT_PACKAGES } from "../src/index.js";

// Seam under test: the one table of official plugins (`packages/protocol/src/official-plugins.ts`) against the
// plugin packages in `plugins/` and the binary manifest it names downloads from.
const PLUGINS_DIR = fileURLToPath(new URL("../../../plugins/", import.meta.url));

interface PluginDir {
  dir: string;
  manifest: { name: string; contributes: Record<string, string[] | undefined> };
}

const pluginDirs: PluginDir[] = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ dir: entry.name, manifest: JSON.parse(readFileSync(join(PLUGINS_DIR, entry.name, "frameshell-plugin.json"), "utf8")) }));

const CONTRIBUTION = { "clip-adapter": "clipTypes", "transcription-provider": "transcriptionProviders", "speech-provider": "speechProviders" } as const;

describe("official plugin table", () => {
  it("has an entry for every plugin directory and no other", () => {
    expect(OFFICIAL_PLUGINS.map((plugin) => plugin.name).sort()).toEqual(pluginDirs.map((plugin) => plugin.manifest.name).sort());
    expect(new Set(OFFICIAL_PLUGINS.map((plugin) => plugin.name)).size).toBe(OFFICIAL_PLUGINS.length);
  });

  it("names each package and contribution as its manifest and package.json do", () => {
    for (const { dir, manifest } of pluginDirs) {
      const entry = officialPlugin(manifest.name)!;
      const pkg = JSON.parse(readFileSync(join(PLUGINS_DIR, dir, "package.json"), "utf8")) as { name: string };
      expect(entry.name).toBe(pkg.name);
      expect([...entry.provides].sort()).toEqual([...(manifest.contributes[CONTRIBUTION[entry.kind]] ?? [])].sort());
      for (const [field, ids] of Object.entries(manifest.contributes)) {
        if (field !== CONTRIBUTION[entry.kind] && (field === "clipTypes" || field === "transcriptionProviders" || field === "speechProviders")) expect(ids, `${manifest.name} ${field}`).toEqual([]);
      }
    }
  });

  it("names only binary packages and models the manager pins", () => {
    const packages = new Set(DEFAULT_PACKAGES.map((pkg) => pkg.name));
    const models = new Set(DEFAULT_MODELS.map((model) => model.id));
    for (const plugin of OFFICIAL_PLUGINS) {
      for (const download of plugin.downloads) {
        expect((download.kind === "binary" ? packages : models).has(download.id), `${plugin.name} ${download.kind} ${download.id}`).toBe(true);
      }
    }
  });

  it("asks for the packages a plugin requests through ensureBinary, and the model its provider defaults to", () => {
    const whisper = readFileSync(join(PLUGINS_DIR, "whisper-cpp", "src", "provider.ts"), "utf8");
    const model = /export const DEFAULT_MODEL = "([^"]+)"/.exec(whisper)![1];
    expect(officialPlugin("@frameshell/whisper-cpp")!.downloads).toContainEqual(expect.objectContaining({ kind: "model", id: `ggml-${model}` }));

    for (const plugin of OFFICIAL_PLUGINS.filter((candidate) => candidate.kind === "clip-adapter")) {
      const dir = plugin.name.replace("@frameshell/", "");
      const source = readdirSync(join(PLUGINS_DIR, dir, "src"))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFileSync(join(PLUGINS_DIR, dir, "src", file), "utf8"))
        .join("\n");
      const asked = [...source.matchAll(/ensureBinary\("([^"]+)"\)/g)].map((match) => match[1]!);
      const tools = (id: string) => DEFAULT_PACKAGES.find((pkg) => pkg.name === id)!.tools;
      for (const tool of asked.filter((name) => name !== "blender" && name !== "ffprobe")) {
        expect(plugin.downloads.some((download) => download.kind === "binary" && tools(download.id).includes(tool)), `${plugin.name} downloads ${tool}`).toBe(true);
      }
    }
  });

  it("names the key variable the OpenAI plugins read and the Blender versions the manifest supports", () => {
    for (const plugin of OFFICIAL_PLUGINS.filter((candidate) => candidate.need.kind === "openai-key")) {
      const source = readFileSync(join(PLUGINS_DIR, plugin.name.replace("@frameshell/", ""), "src", "provider.ts"), "utf8");
      expect(plugin.need.variable, plugin.name).toBe(/export const KEY_VARIABLE = "([^"]+)"/.exec(source)![1]);
      expect(plugin.need.text, plugin.name).toContain(plugin.need.variable!);
    }
    expect(OFFICIAL_PLUGINS.filter((candidate) => candidate.need.kind !== "openai-key").every((candidate) => candidate.need.variable === undefined)).toBe(true);
    expect(officialPlugin("@frameshell/blender")!.need.text).toContain(BLENDER_PACKAGE.userInstall!.supported);
  });

  it("finds the plugin for the default transcription provider and each clip type", () => {
    expect(officialPluginProviding("transcription-provider", DEFAULT_TRANSCRIPTION_PROVIDER)?.name).toBe("@frameshell/whisper-cpp");
    expect(officialPluginProviding("clip-adapter", "hyperframes")?.name).toBe("@frameshell/hyperframes");
    expect(officialPluginProviding("speech-provider", "openai")?.name).toBe("@frameshell/openai-speech");
    expect(officialPluginProviding("transcription-provider", "openai")?.name).toBe("@frameshell/openai-transcription");
    expect(officialPluginProviding("clip-adapter", "openai")).toBeUndefined();
  });

  it("states a key plugin as paid and cloud, and a free local one as neither", () => {
    for (const plugin of OFFICIAL_PLUGINS) {
      expect(plugin.paid, plugin.name).toBe(plugin.need.kind === "openai-key");
      expect(plugin.cloud, plugin.name).toBe(plugin.need.kind === "openai-key");
      expect(plugin.purpose.length, plugin.name).toBeGreaterThan(10);
    }
  });
});
