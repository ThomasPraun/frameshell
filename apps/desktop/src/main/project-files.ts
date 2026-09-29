import { readFile, readdir, stat } from "node:fs/promises";
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

/**
 * Watch `root` and call `onChange` with project-relative, `/`-separated
 * paths each time files or folders are added, changed or removed. Resolves
 * once the watcher is ready, so later disk changes are never missed.
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
    },
  };
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
