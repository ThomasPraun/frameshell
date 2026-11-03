import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { type FSWatcher, watch } from "chokidar";

/** `timelines/<id>.json`; the daemon's temp files (`<id>.json.<pid>.<random>.tmp`) do not match. */
const TIMELINE_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;

/** Options for {@link TimelineWatcher}. */
export interface TimelineWatcherOptions {
  /**
   * A timeline file appeared, changed or vanished; see `TimelineService.reconcile`.
   * Called for every existing file on attach too. Errors are ignored: the
   * next operation on the file reports them.
   */
  onChange(root: string, id: string): Promise<void>;
  /** Wait this long for a file to stop growing before reporting it. Default 100 ms. */
  stabilityMs?: number;
}

/**
 * After the watch is live, how long until the folder is listed once more. chokidar lists a folder before it starts
 * `fs.watch`, and macOS FSEvents starts late, so a file created in between would go unseen until its next change.
 */
const RESCAN_AFTER_READY_MS = 1_000;

/**
 * Watches `timelines/*.json` of attached projects (SPEC §6.4). Reports only
 * paths: deciding whether a change is the daemon's own write, a direct edit
 * to journal or one to reject belongs to the timeline service.
 */
export class TimelineWatcher {
  readonly #options: TimelineWatcherOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  constructor(options: TimelineWatcherOptions) {
    this.#options = options;
  }

  /** Start watching `root`'s timelines. Idempotent. */
  attach(root: string): void {
    if (this.#closed || this.#watchers.has(root)) return;
    const stabilityThreshold = this.#options.stabilityMs ?? 100;
    const watcher = watch(join(root, "timelines"), {
      depth: 0,
      ignored: (path, stats) => stats?.isFile() === true && !TIMELINE_FILE.test(basename(path)),
      // Editors that write in place would otherwise be read half-written, and rejected.
      awaitWriteFinish: { stabilityThreshold, pollInterval: Math.min(25, stabilityThreshold) },
    });
    const onPath = (path: string) => {
      const id = TIMELINE_FILE.exec(basename(path))?.[1];
      if (id) void this.#options.onChange(root, id).catch(() => {});
    };
    watcher.on("add", onPath).on("change", onPath).on("unlink", onPath);
    const folder = join(root, "timelines");
    // A file chokidar never listed is handed to it, so its add waits for the write to finish like any other.
    const rescan = () => {
      if (this.#closed) return;
      void readdir(folder).then(
        (names) => {
          if (this.#closed) return;
          const known = new Set(watcher.getWatched()[folder] ?? []);
          for (const name of names) if (TIMELINE_FILE.test(name) && !known.has(name)) watcher.add(join(folder, name));
        },
        () => {},
      );
    };
    watcher.on("ready", () => {
      rescan();
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        rescan();
      }, RESCAN_AFTER_READY_MS);
      timer.unref();
      this.#timers.add(timer);
    });
    // A vanished or unreadable timelines/ must not crash the daemon.
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
