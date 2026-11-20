import { officialPluginProviding } from "@frameshell/protocol/official-plugins";

/**
 * Terminal command that installs the official plugin providing transcription `provider`, from the one official table;
 * `frameshell plugin catalog` (which lists every choice) when no official plugin provides it.
 */
export function transcriptionInstallCommand(provider: string): string {
  const plugin = officialPluginProviding("transcription-provider", provider);
  return plugin ? `frameshell plugin install ${plugin.name}` : "frameshell plugin catalog";
}
