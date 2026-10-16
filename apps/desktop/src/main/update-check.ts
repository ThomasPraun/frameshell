// Update check (#193), pure parts: version order, update mode per build, GitHub release parsing, opt-out store.
// Electron wiring: updater.ts.
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@frameshell/core/fs-util";

/** Repository whose GitHub Releases carry the installers and the update metadata (`latest-mac.yml`, `latest-linux.yml`). */
export const RELEASES_REPO = { owner: "ThomasPraun", repo: "frameshell" } as const;
/** Newest published, non-prerelease release; drafts are invisible to it. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/latest`;
/** Download page the banner links to when the release names no page of its own. */
export const DOWNLOAD_PAGE = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/latest`;
/** First automatic check after start: late enough not to compete with the daemon's cold start. */
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How this build updates.
 * - `auto`: electron-updater downloads the update and offers "Restart to update" (macOS, AppImage).
 * - `notify`: a banner links to the download page (Windows stays unsigned, `.deb` is installed by a package manager).
 * - `off`: no check (dev, e2e, CI and local builds, or `FRAMESHELL_UPDATE_CHECK=0`).
 */
export type UpdateMode = "auto" | "notify" | "off";

/**
 * Update mode of a build. Only packaged builds with a release version check: CI and local packages are
 * `0.0.0-ci.<run>` / `0.0.0-local` (`scripts/release/plan.mjs`). `FRAMESHELL_UPDATE_CHECK=0` turns the check off,
 * `=1` forces it (an unpackaged build then only notifies: electron-updater installs packaged apps only).
 * Linux: `APPIMAGE` is set by the AppImage runtime; without it the app came from the `.deb`.
 */
export function updateMode(input: {
  packaged: boolean;
  platform: NodeJS.Platform;
  version: string;
  env: Record<string, string | undefined>;
}): UpdateMode {
  const { packaged, platform, version, env } = input;
  const flag = env["FRAMESHELL_UPDATE_CHECK"];
  if (flag === "0") return "off";
  const forced = flag === "1";
  if (!forced && (!packaged || !parseVersion(version) || version.startsWith("0.0.0"))) return "off";
  if (!packaged) return "notify";
  if (platform === "darwin") return "auto";
  if (platform === "linux") return env["APPIMAGE"] ? "auto" : "notify";
  if (platform === "win32") return "notify";
  return "off";
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

/** Semver order of `a` and `b` (a leading `v` allowed): negative, 0 or positive. Null when either is not semver. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return diff;
  }
  // A prerelease sorts before its release; identifiers compare numerically when both are numbers (semver §11).
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `candidate` is a newer version than `current`. False when either is not semver. */
export function isNewer(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}

/** A published release, as the update check needs it. */
export interface ReleaseInfo {
  /** Semver without the leading `v`, e.g. `0.8.0`. */
  version: string;
  /** Page to download it from. */
  url: string;
}

/** The release in a GitHub `releases/latest` reply; null for a draft, a prerelease or a tag that is not `v<semver>`. */
export function releaseFromGitHub(reply: unknown): ReleaseInfo | null {
  if (typeof reply !== "object" || reply === null) return null;
  const { tag_name: tag, html_url: page, draft, prerelease } = reply as Record<string, unknown>;
  if (draft === true || prerelease === true || typeof tag !== "string" || !tag.startsWith("v")) return null;
  const version = tag.slice(1);
  if (!parseVersion(version)) return null;
  // Only a page on github.com: the banner opens it in the browser.
  const url = typeof page === "string" && page.startsWith("https://github.com/") ? page : DOWNLOAD_PAGE;
  return { version, url };
}

/**
 * The user's update choices, in `configDir` (a user decision): `automatic`
 * checks on start and daily, on by default. "Check for Updates…" works either way.
 */
export class UpdatePreferences {
  #automatic = true;

  /** @param file JSON file holding the choices; created on the first change. */
  constructor(private readonly file: string) {}

  /** Read the file; a missing or unreadable one means the defaults. */
  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as { automatic?: unknown } | null;
      this.#automatic = stored?.automatic !== false;
    } catch {
      this.#automatic = true;
    }
  }

  /** Check on start and daily. */
  get automatic(): boolean {
    return this.#automatic;
  }

  async setAutomatic(automatic: boolean): Promise<void> {
    this.#automatic = automatic;
    await writeJsonAtomic(this.file, { automatic });
  }
}
