import { type MethodResult, OFFICIAL_PLUGINS, type OfficialDownload, type OfficialPlugin } from "@frameshell/protocol";
import type { BinaryManager, ProjectBinaries } from "../binaries/manager.js";

type Catalog = MethodResult<"plugin.catalog">;
type CatalogEntry = Catalog["plugins"][number];

/** What {@link buildCatalog} reads besides the table. */
export interface CatalogInputs {
  /** Reads the managed downloads' state. */
  binaries: BinaryManager;
  /** Project root and its `binaries` overrides. */
  project: ProjectBinaries;
  /** The project's plugins as `plugin.list` reports them. */
  listed: MethodResult<"plugin.list">;
  /**
   * Model the project transcribes with for `provider` (its `transcription.model` when it uses that provider, else this
   * machine's default), with `registered` true for a file added with `model add`; undefined when none is chosen.
   */
  chosenModel?: (provider: string) => Promise<{ id: string; registered: boolean } | undefined>;
  /** Environment the OpenAI key is looked for in; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The official plugins with their state in one project and on this machine. Reads only: nothing is downloaded,
 * installed or loaded, and the OpenAI key is reduced to set or not.
 */
export async function buildCatalog({ binaries, project, listed, chosenModel, env = process.env }: CatalogInputs): Promise<Catalog> {
  const plugins: CatalogEntry[] = [];
  for (const plugin of OFFICIAL_PLUGINS) {
    const downloads = await Promise.all(plugin.downloads.map((download) => downloadState(binaries, project, download, chosenModel)));
    const info = listed.plugins.find((candidate) => candidate.name === plugin.name);
    plugins.push({
      name: plugin.name,
      kind: plugin.kind,
      provides: [...plugin.provides],
      purpose: plugin.purpose,
      need: { ...plugin.need, met: await needMet(plugin, binaries, project, env) },
      paid: plugin.paid,
      cloud: plugin.cloud,
      downloads,
      downloadBytes: downloads.reduce((total, download) => total + (download.onDisk ? 0 : (download.bytes ?? 0)), 0),
      installed: info !== undefined,
      pin: info?.pin ?? null,
      status: info?.status ?? null,
      version: info?.version ?? null,
      error: info?.error ?? null,
    });
  }
  return { dir: listed.dir, platform: binaries.platform, trust: listed.trust, plugins };
}

async function downloadState(
  binaries: BinaryManager,
  project: ProjectBinaries,
  download: OfficialDownload,
  chosenModel: CatalogInputs["chosenModel"],
): Promise<CatalogEntry["downloads"][number]> {
  const { kind, id, what } = download;
  if (kind === "model") {
    const chosen = download.chosenModel ? await chosenModel?.(download.chosenModel.provider) : undefined;
    // A file registered with `model add` is already on this machine: nothing to download.
    if (chosen?.registered) return { kind, id: chosen.id, what: `Speech model ${chosen.id}, a file on this machine`, bytes: null, onDisk: true };
    const managed = chosen ? `${download.chosenModel!.prefix}${chosen.id}` : id;
    const model = await binaries.locateModel(managed).catch(() => null);
    // An id the manager does not pin: the provider refuses it when it runs, so there is nothing to size.
    if (!model) return { kind, id: managed, what: `Speech model ${chosen!.id}`, bytes: null, onDisk: false };
    return { kind, id: managed, what: managed === id ? what : `Speech model ${chosen!.id}`, bytes: model.pinned.size, onDisk: model.installed };
  }
  // Any tool of the package answers for it: its tools install together.
  const tool = binaries.tools().find((name) => binaries.packageOf(name).name === id);
  if (!tool) throw new Error(`Official plugin catalog names binary package "${id}", which the binary manager does not have.`);
  const location = await binaries.locate(tool, project);
  const bytes = location.pinned ? location.pinned.archives.reduce((total, archive) => total + archive.size, 0) : null;
  return { kind, id, what, bytes, onDisk: location.installed };
}

async function needMet(plugin: OfficialPlugin, binaries: BinaryManager, project: ProjectBinaries, env: Readonly<Record<string, string | undefined>>): Promise<boolean | null> {
  switch (plugin.need.kind) {
    case "none":
      return true;
    case "openai-key":
      return (env[plugin.need.variable ?? ""] ?? "").trim() !== "";
    case "blender":
      return (await binaries.locate("blender", project)).installed;
    case "remotion-project":
      return null;
  }
}
