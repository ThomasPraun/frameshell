import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { BEATS_DIR, readBeatsFile } from "./beats-store.js";

/** `beats/<name>.beats.json`, at any depth below `beats/`; the daemon's temp files (`….beats.json.<pid>.<random>.tmp`) do not match. */
const BEATS_FILE = /\.beats\.json$/;

/** What happened to a beats file, as `beats.changed` reports it. */
export interface BeatsFileChange {
  /** Project root as it was attached. */
  root: string;
  /** Project-relative, `/`-separated. */
  file: string;
  /** `written`: valid now; `removed`: gone; `invalid`: unreadable or against the schema (`message`). */
  change: "written" | "removed" | "invalid";
  message?: string;
}

/** Options for {@link BeatsWatcher}. */
export interface BeatsWatcherOptions {
  /** A beats file was added, changed, vanished or turned invalid, once its write has finished. */
  onChange(change: BeatsFileChange): void;
  /** Wait this long for a file to stop growing before reporting it. Default 100 ms. */
  stabilityMs?: number;
}

/** Same late-start guard as the timeline watcher: macOS FSEvents may miss a file created while the folder was listed. */
const RESCAN_AFTER_READY_MS = 1_000;

/**
 * Watches `beats/**` of attached projects (ADR 0029 decision 3, slice 3). The beats file is read on every use, so
 * there is no state to reconcile; what a hand edit needs is for the app and agents to learn the grid changed, and to
 * hear when the file no longer validates (the grid is then unavailable instead of silently stale). Each report is
 * the file's state after the write settled: validated with the schema `file.write` and `beats.measure` share.
 */
export class BeatsWatcher {
  readonly #options: BeatsWatcherOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  constructor(options: BeatsWatcherOptions) {
    this.#options = options;
  }

  /** Start watching `root`'s `beats/` folder, which may not exist yet. Idempotent. */
  attach(root: string): void {
    if (this.#closed || this.#watchers.has(root)) return;
    const stabilityThreshold = this.#options.stabilityMs ?? 100;
    const folder = join(root, BEATS_DIR);
    const watcher = watch(folder, {
      ignored: (path, stats) => stats?.isFile() === true && !BEATS_FILE.test(basename(path)),
      // Editors that write in place would otherwise be read half-written, and reported invalid.
      awaitWriteFinish: { stabilityThreshold, pollInterval: Math.min(25, stabilityThreshold) },
      // What was there when the app opened is not a change.
      ignoreInitial: true,
    });
    const report = async (path: string, vanished: boolean) => {
      if (this.#closed || !BEATS_FILE.test(basename(path))) return;
      const file = [BEATS_DIR, ...path.slice(folder.length + 1).split(/[\\/]/)].join("/");
      if (vanished) {
        this.#options.onChange({ root, file, change: "removed" });
        return;
      }
      try {
        await readBeatsFile(path);
        this.#options.onChange({ root, file, change: "written" });
      } catch (error) {
        this.#options.onChange({ root, file, change: "invalid", message: (error as Error).message });
      }
    };
    watcher
      .on("add", (path) => void report(path, false))
      .on("change", (path) => void report(path, false))
      .on("unlink", (path) => void report(path, true));
    // A file chokidar never listed is handed to it, so its add waits for the write to finish like any other.
    const rescan = () => {
      if (this.#closed) return;
      void readdir(folder, { recursive: true }).then(
        (names) => {
          if (this.#closed) return;
          const known = new Set(Object.entries(watcher.getWatched()).flatMap(([dir, entries]) => entries.map((entry) => join(dir, entry))));
          for (const name of names) if (BEATS_FILE.test(name) && !known.has(join(folder, name))) watcher.add(join(folder, name));
        },
        () => {},
      );
    };
    watcher.on("ready", () => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        rescan();
      }, RESCAN_AFTER_READY_MS);
      timer.unref();
      this.#timers.add(timer);
    });
    // A vanished or unreadable beats/ must not crash the daemon.
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
