import { ASSETS, assetUrl } from "../site";

/* Copy buttons next to shell commands. */
document.addEventListener("click", async (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-copy]");
  if (!button) return;
  const text = button.parentElement?.querySelector("code")?.textContent?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    button.dataset.copied = "";
    setTimeout(() => {
      button.textContent = "Copy";
      delete button.dataset.copied;
    }, 1600);
  } catch {
    // Clipboard denied: the command stays selectable.
  }
});

type AssetKey = keyof typeof ASSETS;

/** Best guess at the visitor's platform; null when the page cannot tell (mobile, unknown). */
function platform(): { key: AssetKey; label: string } | null {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad/i.test(ua)) return null;
  if (/Mac/i.test(ua)) return { key: "macArm", label: "Download for macOS" };
  if (/Windows/i.test(ua)) return { key: "windows", label: "Download for Windows" };
  if (/Linux/i.test(ua)) return { key: "appImage", label: "Download for Linux" };
  return null;
}

/*
 * Points the download buttons at the right file. Version comes from the build; the GitHub API
 * refresh catches releases published since the last deploy.
 */
async function wireDownloads() {
  const versionEl = document.querySelector<HTMLElement>("[data-version]");
  let version = versionEl?.textContent?.replace(/^v/, "") ?? "";
  const apply = () => {
    const p = platform();
    for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-download]")) {
      if (!p || !version) continue;
      // Intel Macs cannot be told apart from Apple silicon by UA; the Get started table lists both.
      a.href = assetUrl(version, p.key);
      const label = a.querySelector("[data-download-label]");
      if (label) label.textContent = p.label;
    }
    for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-asset]")) {
      a.href = assetUrl(version, a.dataset.asset as AssetKey);
    }
    if (versionEl) versionEl.textContent = `v${version}`;
  };
  apply();
  try {
    const res = await fetch("https://api.github.com/repos/ThomasPraun/frameshell/releases/latest");
    if (!res.ok) return;
    const latest = ((await res.json()) as { tag_name: string }).tag_name.replace(/^v/, "");
    if (latest !== version) {
      version = latest;
      apply();
    }
  } catch {
    // Offline or rate limited: the build-time version stands.
  }
}

wireDownloads();
