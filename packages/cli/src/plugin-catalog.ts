import type { MethodResult } from "@frameshell/protocol";

const KIND_LABEL = { "clip-adapter": "clip type", "transcription-provider": "transcription provider", "speech-provider": "speech provider" } as const;

/** Human text of `plugin.catalog`: one block per official plugin, what it needs and downloads, and whether this project has it. */
export function formatPluginCatalog(result: MethodResult<"plugin.catalog">): string {
  const trust = result.trust === "not-required" ? "no plugins declared" : result.trust === "trusted" ? "plugins trusted" : `plugins ${result.trust === "denied" ? "denied" : "not trusted yet"}`;
  const lines = [`Official plugins for ${result.dir} (${trust}; download sizes for ${result.platform}). Installing any of them is optional.`];
  for (const plugin of result.plugins) {
    const state = !plugin.installed ? "not installed" : plugin.status === "loaded" ? "installed" : `installed, ${plugin.status}`;
    lines.push("", `${plugin.name}  ${state}`);
    lines.push(`  ${plugin.purpose} (${KIND_LABEL[plugin.kind]}: ${plugin.provides.join(", ")})`);
    const met = plugin.need.met === false ? " [not found yet]" : "";
    lines.push(`  needs: ${plugin.need.text}${met}`);
    if (plugin.paid || plugin.cloud) lines.push(`  ${[plugin.paid ? "paid per use" : null, plugin.cloud ? "data leaves this computer" : null].filter(Boolean).join(", ")}`);
    lines.push(`  download: ${downloadSummary(plugin)}`);
    if (plugin.error) lines.push(`  error: ${plugin.error.replace(/\n/g, "\n    ")}`);
    if (!plugin.installed) lines.push(`  install: frameshell plugin install ${plugin.name}`);
  }
  return `${lines.join("\n")}\n`;
}

function downloadSummary(plugin: MethodResult<"plugin.catalog">["plugins"][number]): string {
  if (plugin.downloads.length === 0) return "nothing";
  const parts = plugin.downloads.map((download) => {
    const size = download.bytes === null ? "no build for this platform" : megabytes(download.bytes);
    return `${download.id} ${download.onDisk ? "on disk" : size}`;
  });
  const total = plugin.downloadBytes === 0 ? "nothing more to download" : `${megabytes(plugin.downloadBytes)} on first use`;
  return `${total} (${parts.join(", ")})`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
