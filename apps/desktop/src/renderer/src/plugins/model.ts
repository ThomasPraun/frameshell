import type { PluginInfo, TrustState } from "@frameshell/protocol";
import type { MachineDownloads, PluginsView } from "../../../shared/api.js";

/** One official plugin as `plugin.catalog` reports it. */
export type CatalogPlugin = PluginsView["catalog"]["plugins"][number];

/** Where an official plugin stands in the project. */
export type PluginState = "not-installed" | "loaded" | "error" | "untrusted";

/** What using the plugin costs: nothing, or a paid cloud service that receives audio or text. */
export type PluginCost = "free" | "cloud-audio" | "cloud-text";

/** What the plugin downloads on first use, from this machine's point of view. */
export type PluginDownload =
  | { state: "none" }
  /** `bytes` 0 when no build is pinned for this machine: the size is unknown. */
  | { state: "first-use"; bytes: number; names: string[] }
  | { state: "ready"; names: string[] };

/** One row of the Plugins section. */
export interface PluginRow {
  name: string;
  state: PluginState;
  version: string | null;
  error: string | null;
  need: CatalogPlugin["need"];
  cost: PluginCost;
  download: PluginDownload;
  /** Install shows (not installed); `installBlocked` = the project's trust must be decided first. */
  install: boolean;
  installBlocked: boolean;
  /** Remove shows (installed). */
  remove: boolean;
}

/** The trust banner: `ask` when never decided for the declared list, `denied` when refused, null when none is due. */
export type TrustPrompt = "ask" | "denied" | null;

/** Plugin install only runs on a project with no plugins yet or a trusted list (`plugin.install` refuses otherwise). */
function canInstall(trust: TrustState): boolean {
  return trust === "not-required" || trust === "trusted";
}

/** State of `plugin` from its catalog fields. */
export function pluginState(plugin: Pick<CatalogPlugin, "installed" | "status">): PluginState {
  if (!plugin.installed || plugin.status === null) return "not-installed";
  return plugin.status;
}

/**
 * The official plugins of `catalog` as rows, in catalog order but `first` (plugin names) ahead: a video made from an
 * idea needs a generator before a transcriber (#752).
 */
export function pluginRows(catalog: PluginsView["catalog"], first: readonly string[] = []): PluginRow[] {
  const ahead = (name: string) => (first.includes(name) ? 0 : 1);
  return [...catalog.plugins].sort((a, b) => ahead(a.name) - ahead(b.name)).map((plugin) => {
    const state = pluginState(plugin);
    const missing = plugin.downloads.filter((download) => !download.onDisk);
    const download: PluginDownload =
      plugin.downloads.length === 0
        ? { state: "none" }
        : missing.length > 0
          ? { state: "first-use", bytes: plugin.downloadBytes, names: missing.map((item) => item.id) }
          : { state: "ready", names: plugin.downloads.map((item) => item.id) };
    return {
      name: plugin.name,
      state,
      version: plugin.version,
      error: plugin.error,
      need: plugin.need,
      cost: plugin.cloud || plugin.paid ? (plugin.kind === "transcription-provider" ? "cloud-audio" : "cloud-text") : "free",
      download,
      install: state === "not-installed",
      installBlocked: state === "not-installed" && !canInstall(catalog.trust),
      remove: state !== "not-installed",
    };
  });
}

/** Which trust banner the project needs. */
export function trustPrompt(trust: TrustState): TrustPrompt {
  return trust === "unknown" ? "ask" : trust === "denied" ? "denied" : null;
}

/** Declared plugins the official catalog does not list (installed from a terminal). */
export function otherPlugins(view: PluginsView): PluginInfo[] {
  const official = new Set(view.catalog.plugins.map((plugin) => plugin.name));
  return view.declared.filter((plugin) => !official.has(plugin.name));
}

/** What a managed download is for, as the Downloads list says it (#753). */
export type DownloadUse = "video" | "transcription" | "live" | "chrome" | "voices" | "faces" | "pick" | "matte";

/** Managed package or model names (`doctor` `downloads`, exact or by prefix) and what they are for. */
const USES: readonly [RegExp, DownloadUse][] = [
  [/^ffmpeg$/, "video"],
  [/^whisper-cpp$|^ggml-large-/, "transcription"],
  [/^whisper-server$|^ggml-(small|base)-/, "live"],
  [/^chrome-headless-shell$/, "chrome"],
  [/^sherpa-onnx$|^pyannote-|^3dspeaker-/, "voices"],
  [/^onnxruntime-web$|^yunet-|^sface-/, "faces"],
  [/^mobilesam-/, "pick"],
  [/^mediapipe-/, "matte"],
];

/** What the download `name` is for; null for one this app has no words for. */
export function downloadUse(name: string): DownloadUse | null {
  return USES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** One managed download of this machine, on disk or still to come. */
export interface DownloadRow {
  name: string;
  kind: "package" | "model";
  /** On disk: bytes it takes; not yet: its download size, null when unknown. */
  bytes: number | null;
  onDisk: boolean;
}

/**
 * The Downloads section: what is on disk (biggest first, as `doctor` sorts it), then what is not downloaded yet,
 * with its download size from an official plugin's catalog entry or the pinned build. Overrides, the person's own installs (Blender) and
 * tools with no build for this machine are never listed. `totalBytes` sums what is on disk.
 */
export function downloadRows(machine: MachineDownloads, catalog: PluginsView["catalog"] | null): { rows: DownloadRow[]; totalBytes: number } {
  const rows: DownloadRow[] = machine.downloads.map(({ name, kind, bytes }) => ({ name, kind, bytes, onDisk: true }));
  const listed = new Set(rows.map((row) => row.name));
  const later = (row: DownloadRow) => {
    if (listed.has(row.name)) return;
    listed.add(row.name);
    rows.push(row);
  };
  for (const plugin of catalog?.plugins ?? []) {
    for (const download of plugin.downloads) {
      if (!download.onDisk) later({ name: download.id, kind: download.kind === "binary" ? "package" : "model", bytes: download.bytes, onDisk: false });
    }
  }
  for (const binary of machine.binaries) {
    if (binary.source === "managed" && binary.pinned !== null && !binary.installed) {
      later({ name: binary.package, kind: "package", bytes: binary.pinned.bytes > 0 ? binary.pinned.bytes : null, onDisk: false });
    }
  }
  return { rows, totalBytes: machine.downloads.reduce((total, download) => total + download.bytes, 0) };
}

/** Longest first line an error shows in full before it is cut at its first sentence. */
const HEAD_MAX = 140;

/**
 * A plugin error split for a card: `head` is its first line, or the first sentence of a long first line;
 * `rest` is everything after, trimmed, or null when nothing is left.
 */
export function errorParts(text: string): { head: string; rest: string | null } {
  const trimmed = text.trim();
  const lineEnd = trimmed.indexOf("\n");
  let head = lineEnd < 0 ? trimmed : trimmed.slice(0, lineEnd).trim();
  if (head.length > HEAD_MAX) {
    const sentence = /^.{20,}?[.:;](?=\s)/.exec(head);
    if (sentence) head = sentence[0];
  }
  const rest = trimmed.slice(trimmed.indexOf(head) + head.length).trim();
  return { head, rest: rest === "" ? null : rest };
}
