export const REPO = "https://github.com/ThomasPraun/frameshell";
export const RELEASES = `${REPO}/releases/latest`;

/** Shown until the build or the visitor's browser reads the latest release from the GitHub API. */
export const FALLBACK_VERSION = "0.15.0";

/** Release asset per platform; `{v}` is the version without the leading `v`. */
export const ASSETS = {
  macArm: "Frameshell-{v}-mac-arm64.dmg",
  macIntel: "Frameshell-{v}-mac-x64.dmg",
  windows: "Frameshell-{v}-win-x64.exe",
  deb: "Frameshell-{v}-linux-amd64.deb",
  appImage: "Frameshell-{v}-linux-x86_64.AppImage",
} as const;

export function assetUrl(version: string, key: keyof typeof ASSETS): string {
  return `${REPO}/releases/download/v${version}/${ASSETS[key].replace("{v}", version)}`;
}

/** Latest release version at build time; the fallback when GitHub is unreachable. */
export async function latestVersion(): Promise<string> {
  try {
    const res = await fetch("https://api.github.com/repos/ThomasPraun/frameshell/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return FALLBACK_VERSION;
    const { tag_name } = (await res.json()) as { tag_name: string };
    return tag_name.replace(/^v/, "");
  } catch {
    return FALLBACK_VERSION;
  }
}
