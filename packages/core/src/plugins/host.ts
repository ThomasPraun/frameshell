import { join } from "node:path";
import {
  type AppDirs,
  ErrorCode,
  type MethodResult,
  type PluginInfo,
  type PluginPins,
  RpcError,
  type TrustState,
} from "@frameshell/protocol";
import type { TranscriptionProvider } from "@frameshell/plugin-api";
import { type LoadedPlugin, PluginLoadError, loadPlugin, readManifest } from "./loader.js";
import { parsePluginSpec } from "./spec.js";
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
}

interface ProjectPlugins {
  hash: string;
  plugins: LoadedPlugin[];
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

  constructor(options: PluginHostOptions) {
    this.#trust = new TrustStore(options.dirs);
    this.#pins = options.pins;
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

  /** Install `rawSpec`, validate its manifest, pin it and trust the resulting plugin list. */
  install(root: string, rawSpec: string): Promise<MethodResult<"plugin.install">> {
    const spec = parsePluginSpec(rawSpec);
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
      const { loaded } = await this.#ensureLoaded(root);
      const plugin = loaded?.find((p) => p.info.name === added.name)?.info ?? untrusted(added.name, added.pin);
      return { dir: root, name: added.name, pin: added.pin, plugin };
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
      if (trust === "trusted") {
        await this.#trust.decide(root, next, "trusted");
        await storeFor(root).sync(next).catch(() => {}); // Stale dir is resynced on next load.
      }
      return { dir: root, name, pin };
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

  /** Export presets contributed by the project's loaded plugins. */
  async presets(root: string): Promise<MethodResult<"export.presets">> {
    const { loaded } = await this.#exclusive(root, () => this.#ensureLoaded(root));
    return { presets: (loaded ?? []).flatMap((p) => p.presets.map((preset) => ({ ...preset, plugin: p.info.name }))) };
  }

  /** Current pins and trust; `loaded` is null unless trusted. Caller holds the project lock. */
  async #ensureLoaded(root: string): Promise<{ pins: PluginPins; trust: TrustState; loaded: LoadedPlugin[] | null }> {
    const pins = await this.#pins.readPins(root);
    const trust = await this.#trust.state(root, pins);
    if (trust !== "trusted") return { pins, trust, loaded: null };
    const hash = pluginsHash(pins);
    const cached = this.#loaded.get(root);
    if (cached?.hash === hash) return { pins, trust, loaded: cached.plugins };

    const store = storeFor(root);
    if (!(await store.isSynced(pins))) {
      try {
        await store.sync(pins);
      } catch (error) {
        // Not cached: the next call retries the install.
        const message = `reinstalling from frameshell.json failed: ${(error as Error).message}`;
        const plugins = Object.entries(pins).map(([name, pin]) => failed(name, pin, message));
        return { pins, trust, loaded: plugins };
      }
    }
    const plugins: LoadedPlugin[] = [];
    const owners = new Map<string, string>();
    for (const [name, pin] of Object.entries(pins)) {
      const plugin = await loadPlugin(store.packageDir(name), name, pin, root);
      const clash = [...plugin.commands.keys()].find((command) => owners.has(command));
      if (clash) {
        plugins.push(failed(name, pin, `command "${clash}" is already provided by ${owners.get(clash)}`, plugin));
        continue;
      }
      for (const command of plugin.commands.keys()) owners.set(command, name);
      plugins.push(plugin);
    }
    this.#loaded.set(root, { hash, plugins });
    return { pins, trust, loaded: plugins };
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
