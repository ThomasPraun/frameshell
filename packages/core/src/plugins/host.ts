import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AppDirs,
  ErrorCode,
  type MethodResult,
  type PluginInfo,
  type PluginPins,
  RpcError,
  type TrustState,
} from "@frameshell/protocol";
import type { ClipAdapter, TranscriptionProvider } from "@frameshell/plugin-api";
import type { RegisteredClipType } from "../clips/renderer.js";
import { type LoadedPlugin, PluginLoadError, loadPlugin, readManifest } from "./loader.js";
import { AGENT_SKILLS_DIR, type SkillSync, syncPluginSkills } from "./skills.js";
import { type PluginSpec, parsePluginSpec } from "./spec.js";
import { NpmError, PluginStore } from "./store.js";
import { TrustStore, pluginsHash } from "./trust.js";

/** Where the host reads and writes a project's plugin pins (`frameshell.json`). */
export interface PinsAccess {
  readPins(root: string): Promise<PluginPins>;
  writePins(root: string, pins: PluginPins): Promise<void>;
}

/** Options for {@link PluginHost}. */
export interface PluginHostOptions {
  /** Per-user directories; trust decisions live in the config dir. */
  dirs: AppDirs;
  pins: PinsAccess;
  /** Re-check the clip render keys of project `root`; backs `PluginApi.refreshRenders`. Default: no-op. */
  refreshRenders?(root: string): void;
}

interface ProjectPlugins {
  hash: string;
  plugins: LoadedPlugin[];
  /** Agent skill links as the load that filled this entry left them. */
  skills: SkillSync;
}

/** What {@link PluginHost} knows about a project's plugins; `loaded` and `skills` are null unless trusted. */
interface PluginsState {
  pins: PluginPins;
  trust: TrustState;
  loaded: LoadedPlugin[] | null;
  skills: SkillSync | null;
}

/**
 * Plugin host (SPEC §8): installs, pins, trust-gates and loads the plugins
 * each project declares, and dispatches their contributions.
 *
 * Plugins load lazily on first use and only for trusted projects; a stale
 * `.frameshell/plugins` is reinstalled from the pins first. Work that touches
 * one project's pins or install directory is serialized per project.
 */
export class PluginHost {
  readonly #trust: TrustStore;
  readonly #pins: PinsAccess;
  readonly #loaded = new Map<string, ProjectPlugins>();
  readonly #queues = new Map<string, Promise<unknown>>();

  readonly #refreshRenders: (root: string) => void;

  constructor(options: PluginHostOptions) {
    this.#trust = new TrustStore(options.dirs);
    this.#pins = options.pins;
    this.#refreshRenders = (root) => options.refreshRenders?.(root);
  }

  /** Trust state of `root` for its current pins. */
  trustState(root: string, pins: PluginPins): Promise<TrustState> {
    return this.#trust.state(root, pins);
  }

  /** Record the user's decision for the plugins `root` declares now. */
  setTrust(root: string, decision: "trust" | "deny"): Promise<MethodResult<"project.trust">> {
    return this.#exclusive(root, async () => {
      const pins = await this.#pins.readPins(root);
      if (Object.keys(pins).length > 0) {
        await this.#trust.decide(root, pins, decision === "trust" ? "trusted" : "denied");
        this.#loaded.delete(root);
        // Untrusted plugins teach agents nothing: their skills go with them.
        if (decision === "deny") await syncPluginSkills(root, []).catch(() => {});
      }
      return { dir: root, trust: await this.#trust.state(root, pins), plugins: pins };
    });
  }

  /** Declared plugins with status; loads them when trusted. */
  async list(root: string): Promise<MethodResult<"plugin.list">> {
    const { pins, trust, loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    const plugins = loaded ? loaded.map((p) => p.info) : Object.entries(pins).map(([name, pin]) => untrusted(name, pin));
    return { dir: root, trust, plugins };
  }

  /**
   * Install `rawSpec`, validate its manifest, pin it and trust the resulting
   * plugin list. A tarball path resolves against `cwd` (default `root`).
   */
  install(root: string, rawSpec: string, cwd: string = root): Promise<MethodResult<"plugin.install">> {
    const spec = localTarball(parsePluginSpec(rawSpec), cwd);
    return this.#exclusive(root, async () => {
      const pins = await this.#pins.readPins(root);
      const trust = await this.#trust.state(root, pins);
      // Installing reinstalls the declared plugins too, running their scripts.
      if (trust !== "not-required" && trust !== "trusted") throw notTrusted(root, trust, pins);

      const store = storeFor(root);
      let added: { name: string; pin: string };
      try {
        added = await store.add(pins, spec);
      } catch (error) {
        if (!(error instanceof NpmError)) throw error;
        throw new RpcError(ErrorCode.PluginInstallFailed, `Could not install ${rawSpec}: ${error.message}`, {
          spec: rawSpec,
          output: error.output,
        });
      }
      try {
        await readManifest(store.packageDir(added.name), added.name);
      } catch (error) {
        if (!(error instanceof PluginLoadError)) throw error;
        await store.sync(pins).catch(() => {}); // Best effort: the next trusted load resyncs anyway.
        throw new RpcError(ErrorCode.InvalidPlugin, `${rawSpec} was not installed: ${error.message}`, {
          name: added.name,
          details: error.message,
        });
      }

      const next = { ...pins, [added.name]: added.pin };
      await this.#pins.writePins(root, next);
      await store.markSynced(next);
      // The user picked this list themselves: no prompt for it later.
      await this.#trust.decide(root, next, "trusted");
      this.#loaded.delete(root);
      const { loaded, skills } = await this.#ensureLoaded(root);
      const plugin = loaded?.find((p) => p.info.name === added.name)?.info ?? untrusted(added.name, added.pin);
      const mine = <T extends { plugin: string }>(items: readonly T[] | undefined) => (items ?? []).filter((item) => item.plugin === added.name);
      return {
        dir: root,
        name: added.name,
        pin: added.pin,
        plugin,
        skills: mine(skills?.linked).map((link) => link.path),
        warnings: mine(skills?.warnings).map((warning) => warning.message),
      };
    });
  }

  /** Unpin `name` and uninstall it. Runs npm only for trusted projects. */
  remove(root: string, name: string): Promise<MethodResult<"plugin.remove">> {
    return this.#exclusive(root, async () => {
      const pins = await this.#pins.readPins(root);
      const pin = pins[name];
      if (pin === undefined) {
        throw new RpcError(ErrorCode.PluginNotFound, `${name} is not installed in ${root}`, {
          name,
          installed: Object.keys(pins),
        });
      }
      const trust = await this.#trust.state(root, pins);
      const next = Object.fromEntries(Object.entries(pins).filter(([key]) => key !== name));
      await this.#pins.writePins(root, next);
      this.#loaded.delete(root);
      let skills: string[];
      if (trust === "trusted") {
        await this.#trust.decide(root, next, "trusted");
        await storeFor(root).sync(next).catch(() => {}); // Stale dir is resynced on next load.
      }
      if (trust === "trusted" && Object.keys(next).length > 0) {
        skills = (await this.#ensureLoaded(root)).skills?.removed ?? [];
      } else {
        // Nothing left that may expose skills.
        skills = (await syncPluginSkills(root, [])).removed;
      }
      return { dir: root, name, pin, skills };
    });
  }

  /** Run `frameshell <group> <command> [args]` for the project at `root`. */
  async run(
    root: string,
    cwd: string,
    group: string,
    command: string,
    args: string[],
  ): Promise<MethodResult<"plugin.run">> {
    const { pins, trust, loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    const full = `${group} ${command}`;
    if (!loaded) {
      if (trust === "not-required") throw commandNotFound(full, []);
      throw notTrusted(root, trust, pins);
    }
    const owner = loaded.find((p) => p.commands.has(full));
    if (!owner) {
      const broken = loaded.find((p) => p.manifest?.contributes.commands.includes(full));
      if (broken) {
        throw new RpcError(ErrorCode.InvalidPlugin, `${broken.info.name} failed to load: ${broken.info.error}`, {
          name: broken.info.name,
          details: broken.info.error,
        });
      }
      throw commandNotFound(full, loaded.flatMap((p) => [...p.commands.keys()]));
    }
    let result: unknown;
    try {
      result = await owner.commands.get(full)!.run({ args, cwd, project: { dir: root } });
    } catch (error) {
      throw new RpcError(
        ErrorCode.PluginCommandFailed,
        `frameshell ${full} failed: ${(error as Error)?.message ?? String(error)}`,
        { command: full, plugin: owner.info.name },
      );
    }
    return normalizeResult(result, full, owner.info.name);
  }

  /**
   * Transcription provider `id` from the project's loaded plugins. Throws
   * `ProjectNotTrusted`, `InvalidPlugin` (its plugin failed to load) or
   * `TranscriptionProviderNotFound` (data lists the loaded providers).
   */
  async transcriptionProvider(root: string, id: string): Promise<TranscriptionProvider> {
    const { pins, trust, loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    if (!loaded && trust !== "not-required") throw notTrusted(root, trust, pins);
    const plugins = loaded ?? [];
    const owner = plugins.find((p) => p.providers.has(id));
    if (owner) return owner.providers.get(id)!;
    const broken = plugins.find((p) => p.manifest?.contributes.transcriptionProviders.includes(id));
    if (broken) {
      throw new RpcError(ErrorCode.InvalidPlugin, `${broken.info.name} failed to load: ${broken.info.error}`, {
        name: broken.info.name,
        details: broken.info.error,
      });
    }
    const available = plugins.flatMap((p) => [...p.providers.keys()]);
    const hint =
      id === "whisper-cpp"
        ? " Install the default provider with `frameshell plugin install @frameshell/whisper-cpp`."
        : ` Install the plugin that provides it with \`frameshell plugin install <spec>\`.`;
    throw new RpcError(
      ErrorCode.TranscriptionProviderNotFound,
      `No transcription provider "${id}" in ${root}` +
        (available.length > 0 ? ` (loaded: ${available.join(", ")}).` : ".") +
        hint,
      { provider: id, available },
    );
  }

  /**
   * Clip adapters of the project's loaded plugins, by clip type. Empty when
   * the project's plugins are untrusted: timelines stay editable, only
   * adapter clips cannot be created or have their props changed.
   */
  async clipTypes(root: string): Promise<ReadonlyMap<string, ClipAdapter>> {
    const { loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    return new Map((loaded ?? []).flatMap((p) => [...p.clipTypes]));
  }

  /**
   * {@link clipTypes} with the plugin that registered each adapter: its name
   * and version are part of the clip render cache key (SPEC §6.5).
   */
  async clipAdapters(root: string): Promise<ReadonlyMap<string, RegisteredClipType>> {
    const { loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    return new Map(
      (loaded ?? []).flatMap((p) =>
        [...p.clipTypes].map(([type, adapter]) => [type, { adapter, plugin: { name: p.info.name, version: p.info.version ?? p.info.pin } }] as const),
      ),
    );
  }

  /** Why no loaded plugin of `root` renders clip type `type`, with the fix. */
  async clipTypeUnavailable(root: string, type: string): Promise<string> {
    const { pins, trust, loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    if (!loaded && trust !== "not-required") {
      return (
        `The project's plugins (${Object.keys(pins).join(", ")}) are not trusted${trust === "denied" ? " (trust was denied)" : ""}, ` +
        `so nothing renders \`${type}\` clips. Trust them with \`frameshell plugin list --trust\` if you trust the project's source.`
      );
    }
    const broken = (loaded ?? []).find((p) => p.manifest?.contributes.clipTypes.includes(type));
    if (broken) return `${broken.info.name} provides \`${type}\` clips but failed to load: ${broken.info.error}`;
    const plugin = OFFICIAL_ADAPTERS[type] ?? "<spec>";
    return `No installed plugin renders \`${type}\` clips. Install one: \`frameshell plugin install ${plugin}\`.`;
  }

  /** Export presets contributed by the project's loaded plugins. */
  async presets(root: string): Promise<MethodResult<"export.presets">> {
    const { loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    return { presets: (loaded ?? []).flatMap((p) => p.presets.map((preset) => ({ ...preset, plugin: p.info.name }))) };
  }

  /** Current pins and trust; `loaded` is null unless trusted. Caller holds the project lock. */
  async #ensureLoaded(root: string): Promise<PluginsState> {
    const pins = await this.#pins.readPins(root);
    const trust = await this.#trust.state(root, pins);
    if (trust !== "trusted") return { pins, trust, loaded: null, skills: null };
    const hash = pluginsHash(pins);
    const cached = this.#loaded.get(root);
    if (cached?.hash === hash) return { pins, trust, loaded: cached.plugins, skills: cached.skills };

    const store = storeFor(root);
    if (!(await store.isSynced(pins))) {
      try {
        await store.sync(pins);
      } catch (error) {
        // Not cached: the next call retries the install.
        const message = `reinstalling from frameshell.json failed: ${(error as Error).message}`;
        const plugins = Object.entries(pins).map(([name, pin]) => failed(name, pin, message));
        return { pins, trust, loaded: plugins, skills: null };
      }
    }
    const plugins: LoadedPlugin[] = [];
    const owners = new Map<string, string>();
    for (const [name, pin] of Object.entries(pins)) {
      const plugin = await loadPlugin(store.packageDir(name), name, pin, root, { refreshRenders: () => this.#refreshRenders(root) });
      const clash = [...plugin.commands.keys()].find((command) => owners.has(command));
      if (clash) {
        plugins.push(failed(name, pin, `command "${clash}" is already provided by ${owners.get(clash)}`, plugin));
        continue;
      }
      for (const command of plugin.commands.keys()) owners.set(command, name);
      plugins.push(plugin);
    }
    // Every fresh load re-exposes skills: a clone or a hand-deleted link gets them back.
    const skills = await exposeSkills(root, plugins);
    this.#loaded.set(root, { hash, plugins, skills });
    return { pins, trust, loaded: plugins, skills };
  }

  #exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(root) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    this.#queues.set(root, settled);
    void settled.then(() => {
      if (this.#queues.get(root) === settled) this.#queues.delete(root);
    });
    return next;
  }
}

/** Official plugin of each official clip type, for install hints. */
const OFFICIAL_ADAPTERS: Readonly<Record<string, string>> = {
  hyperframes: "@frameshell/hyperframes",
  remotion: "@frameshell/remotion",
};

/** Link the skills of the plugins that loaded; a failure to link is a warning, never a failed load. */
async function exposeSkills(root: string, plugins: readonly LoadedPlugin[]): Promise<SkillSync> {
  const skills = plugins
    .filter((plugin) => plugin.info.status === "loaded")
    .flatMap((plugin) => (plugin.info.contributes?.skills ?? []).map((file) => ({ plugin: plugin.info.name, file })));
  try {
    return await syncPluginSkills(root, skills);
  } catch (error) {
    const message = `Could not link agent skills into ${AGENT_SKILLS_DIR}: ${(error as Error).message}`;
    return { linked: [], removed: [], warnings: plugins.map((plugin) => ({ plugin: plugin.info.name, message })) };
  }
}

/** A tarball spec with its path made absolute; refuses a path that is not a file before npm runs. */
function localTarball(spec: PluginSpec, cwd: string): PluginSpec {
  if (spec.kind !== "tarball") return spec;
  const path = resolve(cwd, spec.path);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new RpcError(ErrorCode.InvalidPluginSpec, `No such file: ${path} (plugin spec "${spec.spec}").`, { spec: spec.spec });
  }
  return { ...spec, path };
}

function storeFor(root: string): PluginStore {
  return new PluginStore(join(root, ".frameshell", "plugins"));
}

function untrusted(name: string, pin: string): PluginInfo {
  return { name, pin, status: "untrusted", version: null, apiVersion: null, error: null, contributes: null };
}

function failed(name: string, pin: string, error: string, base?: LoadedPlugin): LoadedPlugin {
  return {
    info: { ...(base?.info ?? untrusted(name, pin)), status: "error", error },
    manifest: base?.manifest ?? null,
    commands: new Map(),
    presets: [],
    clipTypes: new Map(),
    providers: new Map(),
  };
}

function notTrusted(root: string, trust: TrustState, pins: PluginPins): RpcError {
  const names = Object.keys(pins).join(", ");
  return new RpcError(
    ErrorCode.ProjectNotTrusted,
    `Project ${root} declares plugins (${names}) that are not trusted${trust === "denied" ? " (trust was denied)" : ""}. ` +
      "Plugins run with full access to your machine. Trust them only if you trust the project's source: " +
      "re-run the command with `--trust` (API: `project.trust`).",
    { dir: root, trust, plugins: pins },
  );
}

function commandNotFound(command: string, available: string[]): RpcError {
  const hint = available.length > 0 ? ` Plugin commands here: ${available.join(", ")}.` : " No plugin provides commands here.";
  return new RpcError(ErrorCode.CommandNotFound, `Unknown command \`frameshell ${command}\`.${hint}`, {
    command,
    available,
  });
}

/** Plugin results cross the wire: strings become `output`, `data` must survive JSON. */
function normalizeResult(result: unknown, command: string, plugin: string): MethodResult<"plugin.run"> {
  if (result === undefined || result === null) return { output: null, data: null };
  if (typeof result === "string") return { output: result, data: null };
  const { output, data } = result as { output?: unknown; data?: unknown };
  try {
    return {
      output: typeof output === "string" ? output : null,
      data: data === undefined ? null : (JSON.parse(JSON.stringify(data)) as unknown),
    };
  } catch (error) {
    throw new RpcError(
      ErrorCode.PluginCommandFailed,
      `frameshell ${command} returned data that is not JSON: ${(error as Error).message}`,
      { command, plugin },
    );
  }
}
