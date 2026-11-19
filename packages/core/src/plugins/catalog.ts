import { type MethodResult, OFFICIAL_PLUGINS, type OfficialDownload, type OfficialPlugin } from "@frameshell/protocol";
import type { BinaryManager, ProjectBinaries } from "../binaries/manager.js";

/** Environment variable the OpenAI plugins read the person's key from. */
const OPENAI_KEY_VARIABLE = "OPENAI_API_KEY";

type Catalog = MethodResult<"plugin.catalog">;
type CatalogEntry = Catalog["plugins"][number];

/** What {@link buildCatalog} reads besides the table. */
export interface CatalogInputs {
  binaries: BinaryManager;
  /** Project root and its `binaries` overrides. */
  project: ProjectBinaries;
  /** The project's plugins as `plugin.list` reports them. */
  listed: MethodResult<"plugin.list">;
  /** Environment the OpenAI key is looked for in; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The official plugins with their state in one project and on this machine. Reads only: nothing is downloaded,
 * installed or loaded, and the OpenAI key is reduced to set or not.
 */
export async function buildCatalog({ binaries, project, listed, env = process.env }: CatalogInputs): Promise<Catalog> {
  const plugins: CatalogEntry[] = [];
  for (const plugin of OFFICIAL_PLUGINS) {
    const downloads = await Promise.all(plugin.downloads.map((download) => downloadState(binaries, project, download)));
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

async function downloadState(binaries: BinaryManager, project: ProjectBinaries, download: OfficialDownload): Promise<CatalogEntry["downloads"][number]> {
  const { kind, id, what } = download;
  if (kind === "model") {
    const model = await binaries.locateModel(id);
    return { kind, id, what, bytes: model.pinned.size, onDisk: model.installed };
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
      return (env[OPENAI_KEY_VARIABLE] ?? "").trim() !== "";
    case "blender":
      return (await binaries.locate("blender", project)).installed;
    case "remotion-project":
      return null;
  }
}
