import type { AssetInfo } from "@frameshell/protocol";
import type { AssetChange, FrameshellApi } from "../../../shared/api.js";
import type { MediaLookup, Peaks, Thumbnails } from "./paint.js";

/** Decoded thumbnails kept at once; each is ~160x90 px. */
const MAX_BITMAPS = 600;
/** Parallel thumbnail reads; more only queue in main. */
const MAX_LOADS = 6;

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };

/**
 * Waveforms and thumbnails of the project's assets, loaded lazily the first
 * time the painter asks and cached. `onLoaded` fires when something new can
 * be drawn. Assets without finished ingest simply have nothing yet. The asset
 * list is read once ({@link MediaCache.refresh}) and then kept current by
 * daemon `asset.changed` events ({@link MediaCache.apply}); nothing polls.
 */
export class MediaCache implements MediaLookup<ImageBitmap> {
  #assets = new Map<string, AssetInfo>();
  readonly #waves = new Map<string, Load<Peaks>>();
  readonly #bitmaps = new Map<string, Load<ImageBitmap>>();
  readonly #strips = new Map<string, Thumbnails<ImageBitmap>>();
  readonly #aspects = new Map<string, number>();
  readonly #queue: { dir: string; path: string }[] = [];
  /** Events received while a {@link MediaCache.refresh} is in flight; replayed over its (possibly older) reply. */
  #pending: Extract<AssetChange, { path: string }>[] | null = null;
  #loading = 0;
  #disposed = false;

  constructor(
    private readonly api: FrameshellApi["media"],
    private readonly onLoaded: () => void,
  ) {}

  /** Re-read every asset (`asset.list`): on mount, and after a daemon reconnect when events may have been missed. */
  async refresh(): Promise<void> {
    const pending: Extract<AssetChange, { path: string }>[] = [];
    this.#pending = pending;
    let assets: AssetInfo[] | null = null;
    try {
      assets = await this.api.assets();
    } catch {
      // Daemon unreachable: keep what we have; events or the next resync fill in.
    }
    if (this.#pending === pending) this.#pending = null;
    if (this.#disposed || !assets) return;
    this.#assets = new Map(assets.map((asset) => [asset.path, asset]));
    this.#strips.clear();
    for (const change of pending) this.#set(change.path, change.asset);
    this.onLoaded();
  }

  /** One daemon `asset.changed`, or a resync (`path: null`) that re-reads everything. */
  apply(change: AssetChange): void {
    if (this.#disposed) return;
    if (change.path === null) {
      void this.refresh();
      return;
    }
    this.#pending?.push(change);
    this.#set(change.path, change.asset);
    this.onLoaded();
  }

  waveform(asset: string): Peaks | null {
    const path = this.#assets.get(asset)?.waveform?.path;
    if (!path) return null;
    const entry = this.#waves.get(path);
    if (entry) return entry.state === "ready" ? entry.value : null;
    this.#waves.set(path, { state: "loading" });
    void this.api
      .read(path)
      .then((bytes) => {
        const { peaksPerSecond, peaks } = JSON.parse(new TextDecoder().decode(bytes)) as Peaks;
        this.#waves.set(path, { state: "ready", value: { peaksPerSecond, peaks } });
        this.onLoaded();
      })
      .catch(() => this.#waves.set(path, { state: "failed" }));
    return null;
  }

  thumbnails(asset: string): Thumbnails<ImageBitmap> | null {
    const info = this.#assets.get(asset)?.thumbnails;
    if (!info || info.count === 0) return null;
    let strip = this.#strips.get(asset);
    if (!strip) {
      const { dir, count, interval } = info;
      const aspects = this.#aspects;
      strip = {
        count,
        interval,
        // Known once the first thumbnail decodes; 16:9 until then.
        get aspect() {
          return aspects.get(dir) ?? 16 / 9;
        },
        image: (index) => this.#image(dir, index),
      };
      this.#strips.set(asset, strip);
    }
    return strip;
  }

  #set(path: string, asset: AssetInfo | null): void {
    if (asset) this.#assets.set(path, asset);
    else this.#assets.delete(path);
    // New content means new derived paths: the strip is rebuilt from them on the next paint.
    this.#strips.delete(path);
  }

  /** Release decoded images; later loads are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#bitmaps.values()) if (entry.state === "ready") entry.value.close();
    this.#bitmaps.clear();
    this.#queue.length = 0;
  }

  #image(dir: string, index: number): ImageBitmap | null {
    const path = `${dir}/${String(index).padStart(4, "0")}.jpg`;
    const entry = this.#bitmaps.get(path);
    if (entry) {
      if (entry.state !== "ready") return null;
      // Most recently used last: eviction takes from the front.
      this.#bitmaps.delete(path);
      this.#bitmaps.set(path, entry);
      return entry.value;
    }
    this.#bitmaps.set(path, { state: "loading" });
    this.#queue.push({ dir, path });
    this.#pump();
    return null;
  }

  #pump(): void {
    while (this.#loading < MAX_LOADS && this.#queue.length > 0) {
      const { dir, path } = this.#queue.shift()!;
      this.#loading++;
      void this.api
        .read(path)
        .then((bytes) => createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" })))
        .then(
          (bitmap) => {
            if (this.#disposed) return bitmap.close();
            this.#aspects.set(dir, bitmap.width / bitmap.height);
            this.#bitmaps.set(path, { state: "ready", value: bitmap });
            this.#evict();
            this.onLoaded();
          },
          () => this.#bitmaps.set(path, { state: "failed" }),
        )
        .finally(() => {
          this.#loading--;
          this.#pump();
        });
    }
  }

  #evict(): void {
    for (const [path, entry] of this.#bitmaps) {
      if (this.#bitmaps.size <= MAX_BITMAPS) break;
      if (entry.state === "loading") continue;
      if (entry.state === "ready") entry.value.close();
      this.#bitmaps.delete(path);
    }
  }
}
