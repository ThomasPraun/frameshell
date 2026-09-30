import type { AssetInfo } from "@frameshell/protocol";
import type { FrameshellApi } from "../../../shared/api.js";
import type { MediaLookup, Peaks, Thumbnails } from "./paint.js";

/** Decoded thumbnails kept at once; each is ~160x90 px. */
const MAX_BITMAPS = 600;
/** Parallel thumbnail reads; more only queue in main. */
const MAX_LOADS = 6;

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };

/**
 * Waveforms and thumbnails of the project's assets, loaded lazily the first
 * time the painter asks and cached. `onLoaded` fires when something new can
 * be drawn. Assets without finished ingest simply have nothing yet.
 */
export class MediaCache implements MediaLookup<ImageBitmap> {
  #assets = new Map<string, AssetInfo>();
  readonly #waves = new Map<string, Load<Peaks>>();
  readonly #bitmaps = new Map<string, Load<ImageBitmap>>();
  readonly #strips = new Map<string, Thumbnails<ImageBitmap>>();
  readonly #aspects = new Map<string, number>();
  readonly #queue: { dir: string; path: string }[] = [];
  #loading = 0;
  #disposed = false;

  constructor(
    private readonly api: FrameshellApi["media"],
    private readonly onLoaded: () => void,
  ) {}

  /** Re-read `asset.list`. Returns true while some asset is still ingesting (poll again later). */
  async refresh(): Promise<boolean> {
    let assets: AssetInfo[];
    try {
      assets = await this.api.assets();
    } catch {
      return false;
    }
    if (this.#disposed) return false;
    this.#assets = new Map(assets.map((asset) => [asset.path, asset]));
    this.#strips.clear();
    this.onLoaded();
    return assets.some((asset) => asset.state === "pending" || asset.state === "processing");
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
