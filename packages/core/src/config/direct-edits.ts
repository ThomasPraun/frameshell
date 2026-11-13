import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConfigDoc } from "@frameshell/protocol";
import { STYLE_FILE } from "@frameshell/schema";
import { type FSWatcher, watch } from "chokidar";
import { exists, writeTextAtomic } from "../fs-util.js";
import { type ConfigJournal, readConfigHead, readConfigJournal, writeConfigHead } from "./journal.js";
import { configHash } from "./patch.js";

/**
 * Hand edits of config documents (ADR 0036 slice 5): `frameshell.json` formats and `style.json` edited outside the
 * daemon while it runs, or while it did not. The watcher reports the files; {@link DirectConfigEdits} diffs the
 * file's keyed state against the head snapshot the journal last wrote and turns a difference into a config operation.
 */

/** The file of each watched config document, project-relative. */
export const CONFIG_FILES: Readonly<Record<ConfigDoc, string>> = { project: "frameshell.json", style: STYLE_FILE };

/** Config document whose file is named `name`. */
function docOf(name: string): ConfigDoc | undefined {
  return (Object.keys(CONFIG_FILES) as ConfigDoc[]).find((doc) => CONFIG_FILES[doc] === name);
}

/** What {@link DirectConfigEdits} needs from the timeline service: `TimelineService.directConfigEdit`. */
export interface ConfigEditSink {
  directConfigEdit(
    root: string,
    doc: ConfigDoc,
    edit: {
      file: string;
      base: Readonly<Record<string, unknown>>;
      next: Readonly<Record<string, unknown>>;
      keep(): Promise<void>;
    },
  ): Promise<unknown>;
}

/** Options for {@link DirectConfigEdits}. */
export interface DirectConfigEditsOptions {
  journal: ConfigJournal;
  sink: ConfigEditSink;
}

/**
 * Journals the hand edits of config documents. Each report of a file is read in the config journal's turn, so it
 * never meets a change the daemon is making. The daemon's own writes arrive as reports too: their state is the
 * journal's last, so they change nothing.
 */
export class DirectConfigEdits {
  readonly #options: DirectConfigEditsOptions;

  constructor(options: DirectConfigEditsOptions) {
    this.#options = options;
  }

  /**
   * `doc`'s file of project `root` appeared, changed or vanished. A keyed difference from what the journal last
   * recorded becomes one `file.edit` operation of author `file` (held by review mode like `file.write`); a file
   * that does not validate is left for its next valid edit. With no snapshot to diff against (a first sight, or a
   * journal ahead of it) the file is only remembered: such an edit stays a gap `revert` refuses to cross.
   */
  reconcile(root: string, doc: ConfigDoc): Promise<void> {
    const { journal, sink } = this.#options;
    return journal.serial(root, async () => {
      let next: Awaited<ReturnType<ConfigJournal["read"]>>;
      try {
        next = await journal.read(root, doc);
      } catch {
        return;
      }
      const hash = configHash(next);
      const head = await readConfigHead(root, doc);
      if (head?.hash === hash) return;
      const last = (await readConfigJournal(root)).filter((entry) => entry.doc === doc).at(-1);
      const behind = head !== null && last !== undefined && head.hash !== last.hash;
      if (!head || behind) {
        // Nothing to diff against. A head that only lacks a journal to compare is still the file as first seen.
        if (!head && (!last || last.hash === hash)) await writeConfigHead(root, doc, next);
        return;
      }
      const file = CONFIG_FILES[doc];
      const kept = async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        let path = join(root, ".frameshell", "rejected", `${stamp}-${file}`);
        for (let n = 2; await exists(path); n++) path = join(root, ".frameshell", "rejected", `${stamp}-${n}-${file}`);
        // A deleted file has nothing to keep.
        const text = await readFile(join(root, file), "utf8").catch(() => null);
        if (text !== null) await writeTextAtomic(path, text);
      };
      await sink.directConfigEdit(root, doc, { file, base: head.state, next, keep: kept });
      // Applied: the journal wrote the head. Held or kept aside: the file is back at the head.
    });
  }
}

/** After the watch is live, how long until the folder is listed once more; see `TimelineWatcher`. */
const RESCAN_AFTER_READY_MS = 1_000;

/** Options for {@link ConfigWatcher}. */
export interface ConfigWatcherOptions {
  /** A config file appeared, changed or vanished, once its write has finished; errors are ignored. */
  onChange(root: string, doc: ConfigDoc): Promise<void>;
  /** Wait this long for a file to stop growing before reporting it. Default 100 ms. */
  stabilityMs?: number;
}

/** Watches `frameshell.json` and `style.json` at the root of attached projects, nothing else in it. */
export class ConfigWatcher {
  readonly #options: ConfigWatcherOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  constructor(options: ConfigWatcherOptions) {
    this.#options = options;
  }

  /** Start watching `root`. Idempotent. Each document is reported once when the watch is live, so its first sight is remembered. */
  attach(root: string): void {
    if (this.#closed || this.#watchers.has(root)) return;
    const stabilityThreshold = this.#options.stabilityMs ?? 100;
    const watcher = watch(root, {
      depth: 0,
      ignored: (path, stats) => stats?.isFile() === true && docOf(basename(path)) === undefined,
      // Editors that write in place would otherwise be read half-written.
      awaitWriteFinish: { stabilityThreshold, pollInterval: Math.min(25, stabilityThreshold) },
    });
    const onPath = (path: string) => {
      const doc = docOf(basename(path));
      if (doc && !this.#closed) void this.#options.onChange(root, doc).catch(() => {});
    };
    watcher.on("add", onPath).on("change", onPath).on("unlink", onPath);
    const rescan = () => {
      if (this.#closed) return;
      void readdir(root).then(
        (names) => {
          if (this.#closed) return;
          const known = new Set(watcher.getWatched()[root] ?? []);
          for (const name of names) if (docOf(name) && !known.has(name)) watcher.add(join(root, name));
        },
        () => {},
      );
    };
    watcher.on("ready", () => {
      // A file that does not exist yet has no `add`: its first sight, an empty document, is still taken.
      for (const doc of Object.keys(CONFIG_FILES) as ConfigDoc[]) void this.#options.onChange(root, doc).catch(() => {});
      rescan();
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        rescan();
      }, RESCAN_AFTER_READY_MS);
      timer.unref();
      this.#timers.add(timer);
    });
    watcher.on("error", () => {});
    this.#watchers.set(root, watcher);
  }

  /** Stop every watch. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }
}
