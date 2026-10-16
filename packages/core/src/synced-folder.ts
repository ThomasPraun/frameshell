// Is a project inside a folder a cloud service syncs (#187)? `.frameshell/` there uploads gigabytes of proxies and
// renders, and a sync client rewriting the history journal mid-write can corrupt it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, win32 } from "node:path";

/** A sync service's folder holding a project. */
export interface SyncedFolder {
  /** Service name for people, e.g. `Dropbox`, `iCloud Drive`. */
  service: string;
  /** The service's folder that holds the project. */
  root: string;
}

/** What detection reads: the real machine by default, fakes in tests. */
export interface SyncHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  isDir(path: string): boolean;
  /** File content, or null when unreadable. */
  readText(path: string): string | null;
}

export const realSyncHost = (): SyncHost => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  isDir: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
});

/** Names of macOS File Provider folders under `~/Library/CloudStorage/`, by prefix. */
const CLOUD_STORAGE: [prefix: string, service: string][] = [
  ["Dropbox", "Dropbox"],
  ["OneDrive", "OneDrive"],
  ["GoogleDrive", "Google Drive"],
  ["Box", "Box"],
];

/** The sync service folder holding `dir`, or null. Only well-known locations are checked; no guessing. */
export function syncedFolder(dir: string, host: SyncHost = realSyncHost()): SyncedFolder | null {
  const windows = host.platform === "win32";
  // Windows paths are checked with win32 rules on any OS, so tests can fake them.
  const relativeTo = windows ? win32.relative : relative;
  const caseless = windows || host.platform === "darwin";
  const fold = (path: string) => (caseless ? path.toLowerCase() : path);
  const inside = (root: string) => {
    const rel = relativeTo(fold(root), fold(dir));
    return rel === "" || (!rel.startsWith("..") && !(windows ? win32.isAbsolute(rel) : rel.startsWith("/")));
  };
  const found = (service: string, root: string): SyncedFolder | null => (inside(root) ? { service, root } : null);
  const candidates: (SyncedFolder | null)[] = [];

  if (host.platform === "darwin") {
    const mobile = join(host.home, "Library", "Mobile Documents");
    candidates.push(found("iCloud Drive", mobile));
    // "Desktop & Documents Folders" in iCloud keeps the usual paths, so only the cloud-side twin tells.
    for (const name of ["Desktop", "Documents"]) {
      if (host.isDir(join(mobile, "com~apple~CloudDocs", name))) candidates.push(found("iCloud Drive", join(host.home, name)));
    }
    const storage = join(host.home, "Library", "CloudStorage");
    const rel = relative(storage.toLowerCase(), dir.toLowerCase());
    if (rel !== "" && !rel.startsWith("..")) {
      const folder = dir.slice(storage.length + 1).split("/")[0] ?? "";
      const service = CLOUD_STORAGE.find(([prefix]) => folder.startsWith(prefix))?.[1] ?? folder;
      candidates.push({ service, root: join(storage, folder) });
    }
  }

  if (windows) {
    for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const root = host.env[key];
      if (root) candidates.push(found("OneDrive", root));
    }
    candidates.push(found("iCloud Drive", win32.join(host.home, "iCloudDrive")));
    // Google Drive for desktop mounts a virtual drive: G:\My Drive, G:\Shared drives.
    const drive = /^([a-z]:\\(?:my drive|shared drives))(?:\\|$)/i.exec(dir);
    if (drive?.[1]) candidates.push({ service: "Google Drive", root: drive[1] });
  }

  // Dropbox writes where its folders are (personal, business) to info.json.
  const infoFiles = windows
    ? [host.env["APPDATA"], host.env["LOCALAPPDATA"]].filter(Boolean).map((base) => win32.join(base ?? "", "Dropbox", "info.json"))
    : [join(host.home, ".dropbox", "info.json")];
  for (const file of infoFiles) {
    const text = host.readText(file);
    if (!text) continue;
    try {
      for (const account of Object.values(JSON.parse(text) as Record<string, { path?: unknown }>)) {
        if (typeof account?.path === "string") candidates.push(found("Dropbox", account.path));
      }
    } catch {
      // A half-written info.json: no answer is better than a wrong one.
    }
  }

  return candidates.find((candidate) => candidate !== null) ?? null;
}
