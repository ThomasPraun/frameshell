import { type FSWatcher as FsWatcher, watch as fsWatch } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { FileNode } from "../shared/api.js";

export type { FileNode } from "../shared/api.js";

/** Explorer view of one project folder: read-only; writes go through the daemon. */
export interface ProjectFiles {
  /** Current tree, folders first then files, each sorted by name. */
  tree(): Promise<FileNode[]>;
  /** UTF-8 content of a project-relative file. Rejects paths leaving the project and files over 5 MB. */
  read(path: string): Promise<string>;
  /** Stop watching. */
  close(): Promise<void>;
}

/** Hidden from the explorer and not watched: VCS, dependencies, daemon-owned state. */
const HIDDEN = new Set([".git", "node_modules", ".frameshell", ".DS_Store"]);
/** Editors are for scripts and JSON, not media: refuse to pull huge files into the renderer. */
const MAX_READ_BYTES = 5 * 1024 * 1024;
/** Stop listing past this many entries so a stray huge folder cannot freeze the UI. */
const MAX_ENTRIES = 20_000;
/** Coalesce bursts (git checkout, agent writing many files) into one change event. */
const DEBOUNCE_MS = 60;
/** Give up proving the OS watch stream live after this; open still succeeds, as before the handshake. */
const LIVENESS_TIMEOUT_MS = 5_000;
/** Probe rewrite period while waiting: writes during the blind window are lost, so keep writing. */
const PROBE_INTERVAL_MS = 10;

/**
 * Watch `root` and call `onChange` with project-relative, `/`-separated
 * paths each time files or folders are added, changed or removed. Resolves
 * once the watcher is ready and the OS event stream is proven live (see
 * {@link armWatchStream}), so later disk changes are not missed.
 */
export async function openProjectFiles(root: string, onChange: (paths: string[]) => void): Promise<ProjectFiles> {
  const toRel = (path: string) => relative(root, path).split(sep).join("/");
  const isHidden = (path: string) => {
    const rel = relative(root, path);
    return rel !== "" && rel.split(sep).some((part) => HIDDEN.has(part));
  };

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(root, { ignored: isHidden, ignoreInitial: true });
  watcher.on("all", (_event, path) => {
    pending.add(toRel(path));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pending];
      pending.clear();
      onChange(changed);
    }, DEBOUNCE_MS);
  });
  await new Promise<void>((ready, fail) => {
    watcher.once("ready", ready);
    watcher.once("error", fail);
  });
  const closeProbe = await armWatchStream();

  return {
    tree: async () => {
      const budget = { left: MAX_ENTRIES };
      return listDir(root, "", budget);
    },
    read: async (path) => {
      const target = resolve(root, path);
      const rel = relative(root, target);
      if (isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`${path} is outside the project`);
      }
      const { size } = await stat(target);
      if (size > MAX_READ_BYTES) throw new Error(`${path} is too large to open in the editor (${size} bytes)`);
      return readFile(target, "utf8");
    },
    close: async () => {
      clearTimeout(timer);
      await watcher.close();
      await closeProbe();
    },
  };
}

/**
 * Wait until this process's directory watches deliver events; returns the probe's closer.
 *
 * macOS: libuv feeds every directory `fs.watch` from one shared FSEvents stream and
 * rebuilds it on a background thread after each new watch. `fs.watch` returns (and
 * chokidar goes `ready`) before the rebuilt stream exists; changes in that gap are
 * dropped, not delayed. A probe folder watched after the project folders joins the
 * stream last, so its first event proves a stream holding the project folders is live.
 * Probe stays watched until close: closing it would rebuild the stream again.
 * Linux (inotify) and Windows watches are live on return: first probe write answers.
 * Probe lives in the OS temp dir: main never writes into the project.
 * Best effort: temp dir unusable or no event within {@link LIVENESS_TIMEOUT_MS}, open proceeds.
 */
async function armWatchStream(): Promise<() => Promise<void>> {
  let dir: string | undefined;
  let probeWatcher: FsWatcher | undefined;
  const closeProbe = async () => {
    probeWatcher?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  };
  try {
    dir = await mkdtemp(join(tmpdir(), "frameshell-watch-probe-"));
    let live = false;
    probeWatcher = fsWatch(dir, () => {
      live = true;
    });
    probeWatcher.on("error", () => {}); // Best effort: a broken probe must not crash main.
    const probe = join(dir, "probe");
    const deadline = Date.now() + LIVENESS_TIMEOUT_MS;
    for (let n = 0; !live && Date.now() < deadline; n++) {
      await writeFile(probe, String(n));
      await new Promise((settle) => setTimeout(settle, PROBE_INTERVAL_MS));
    }
  } catch {
    // Temp dir unusable: open anyway, without the liveness guarantee.
    await closeProbe();
    return async () => {};
  }
  return closeProbe;
}

async function listDir(root: string, rel: string, budget: { left: number }): Promise<FileNode[]> {
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return []; // Removed between listing and reading: the next change event re-lists.
  }
  const visible = entries
    .filter((entry) => !HIDDEN.has(entry.name) && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const nodes: FileNode[] = [];
  for (const entry of visible) {
    if (budget.left-- <= 0) break;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    nodes.push(
      entry.isDirectory()
        ? { kind: "dir", name: entry.name, path, children: await listDir(root, path, budget) }
        : { kind: "file", name: entry.name, path },
    );
  }
  return nodes;
}
