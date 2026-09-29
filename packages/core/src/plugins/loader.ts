import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginInfo } from "@frameshell/protocol";
import {
  type ClipAdapter,
  type ExportPreset,
  PLUGIN_API_VERSION,
  type PluginApi,
  type PluginCommand,
  type PluginManifest,
  type TranscriptionProvider,
} from "@frameshell/plugin-api";
import { PLUGIN_MANIFEST_FILE, parseExportPreset, parsePluginManifest } from "@frameshell/schema";
import { exists, readJsonIfExists } from "../fs-util.js";

/** Plugin unusable as installed: bad manifest, API mismatch, failed `activate`. Message is user-facing. */
export class PluginLoadError extends Error {
  override readonly name = "PluginLoadError";
}

/** One plugin after a load attempt. Contribution maps are empty unless `info.status` is `loaded`. */
export interface LoadedPlugin {
  info: PluginInfo;
  manifest: PluginManifest | null;
  commands: Map<string, PluginCommand>;
  presets: ExportPreset[];
  clipTypes: Map<string, ClipAdapter>;
  providers: Map<string, TranscriptionProvider>;
}

/**
 * Read and check `frameshell-plugin.json` without running plugin code:
 * schema, name matching the installed package, API version, skill files.
 * Throws {@link PluginLoadError}.
 */
export async function readManifest(dir: string, name: string): Promise<PluginManifest> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(join(dir, PLUGIN_MANIFEST_FILE));
  } catch (error) {
    throw new PluginLoadError(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === undefined) {
    throw new PluginLoadError(`${name} is not a Frameshell plugin: it has no ${PLUGIN_MANIFEST_FILE}`);
  }
  const parsed = parsePluginManifest(raw);
  if (!parsed.ok) throw new PluginLoadError(`Invalid ${PLUGIN_MANIFEST_FILE}:\n${parsed.error}`);
  const manifest = parsed.value;
  if (manifest.name !== name) {
    throw new PluginLoadError(`${PLUGIN_MANIFEST_FILE} names "${manifest.name}" but the package is "${name}"`);
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginLoadError(
      `${name} ${manifest.version} targets plugin API v${manifest.apiVersion}, but this Frameshell supports v${PLUGIN_API_VERSION}. ` +
        `Install a version of ${name} built for plugin API v${PLUGIN_API_VERSION}, or ` +
        (Number(manifest.apiVersion) > Number(PLUGIN_API_VERSION) ? "upgrade Frameshell." : "ask its author to update it."),
    );
  }
  for (const skill of manifest.contributes.skills) {
    if (!(await exists(join(dir, skill)))) throw new PluginLoadError(`declares skill ${skill}, but the file is missing`);
  }
  return manifest;
}

/**
 * Validate, import and activate one installed plugin. Never throws: failures
 * come back as `info.status: "error"` so one broken plugin never blocks the project.
 * `pin` busts Node's ESM cache when the same daemon loads a re-pinned plugin.
 */
export async function loadPlugin(dir: string, name: string, pin: string, projectDir: string): Promise<LoadedPlugin> {
  const plugin: LoadedPlugin = {
    info: { name, pin, status: "error", version: null, apiVersion: null, error: null, contributes: null },
    manifest: null,
    commands: new Map(),
    presets: [],
    clipTypes: new Map(),
    providers: new Map(),
  };
  try {
    const manifest = await readManifest(dir, name);
    plugin.manifest = manifest;
    plugin.info.version = manifest.version;
    plugin.info.apiVersion = manifest.apiVersion;
    plugin.info.contributes = {
      ...manifest.contributes,
      skills: manifest.contributes.skills.map((skill) => resolve(dir, skill)),
    };
    await activate(plugin, manifest, dir, pin, projectDir);
    plugin.info.status = "loaded";
  } catch (error) {
    plugin.info.error = error instanceof PluginLoadError ? error.message : `activate failed: ${(error as Error)?.message ?? error}`;
    plugin.commands.clear();
    plugin.presets = [];
    plugin.clipTypes.clear();
    plugin.providers.clear();
  }
  return plugin;
}

async function activate(plugin: LoadedPlugin, manifest: PluginManifest, dir: string, pin: string, projectDir: string) {
  const url = `${pathToFileURL(join(dir, manifest.main)).href}?pin=${encodeURIComponent(pin)}`;
  let mod: { activate?: unknown; default?: { activate?: unknown } };
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (error) {
    throw new PluginLoadError(`could not import ${manifest.main}: ${(error as Error).message}`);
  }
  const entry = typeof mod.activate === "function" ? mod.activate : mod.default?.activate;
  if (typeof entry !== "function") throw new PluginLoadError(`${manifest.main} exports no activate(api) function`);

  const declared = manifest.contributes;
  let open = true;
  const guard = (kind: string, id: string, list: readonly string[], registered: { has(id: string): boolean }) => {
    if (!open) throw new PluginLoadError(`registered ${kind} "${id}" after activate() returned`);
    if (!list.includes(id)) throw new PluginLoadError(`registered ${kind} "${id}", which ${PLUGIN_MANIFEST_FILE} does not declare`);
    if (registered.has(id)) throw new PluginLoadError(`registered ${kind} "${id}" twice`);
  };
  const presetIds = new Set<string>();
  const api: PluginApi = {
    apiVersion: PLUGIN_API_VERSION,
    plugin: { name: manifest.name, version: manifest.version, dir },
    project: { dir: projectDir },
    registerCommand(name, command) {
      guard("command", name, declared.commands, plugin.commands);
      if (typeof command?.run !== "function") throw new PluginLoadError(`command "${name}" has no run() function`);
      plugin.commands.set(name, command);
    },
    registerExportPreset(preset) {
      const parsed = parseExportPreset(preset);
      if (!parsed.ok) throw new PluginLoadError(`invalid export preset:\n${parsed.error}`);
      guard("export preset", parsed.value.id, declared.exportPresets, presetIds);
      presetIds.add(parsed.value.id);
      plugin.presets.push(parsed.value);
    },
    registerClipType(adapter) {
      guard("clip type", adapter?.type, declared.clipTypes, plugin.clipTypes);
      plugin.clipTypes.set(adapter.type, adapter);
    },
    registerTranscriptionProvider(provider) {
      guard("transcription provider", provider?.id, declared.transcriptionProviders, plugin.providers);
      plugin.providers.set(provider.id, provider);
    },
  };
  try {
    await entry(api);
  } finally {
    open = false;
  }
  const missing = [
    ...declared.commands.filter((id) => !plugin.commands.has(id)).map((id) => `command "${id}"`),
    ...declared.exportPresets.filter((id) => !presetIds.has(id)).map((id) => `export preset "${id}"`),
    ...declared.clipTypes.filter((id) => !plugin.clipTypes.has(id)).map((id) => `clip type "${id}"`),
    ...declared.transcriptionProviders.filter((id) => !plugin.providers.has(id)).map((id) => `transcription provider "${id}"`),
  ];
  if (missing.length > 0) throw new PluginLoadError(`declares but never registered: ${missing.join(", ")}`);
}
