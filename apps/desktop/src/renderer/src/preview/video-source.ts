// What the engine worker decodes a layer's pictures from: a media proxy (H.264 MP4, or VP9 WebM with alpha for sources
// with alpha (#90), both read by byte ranges, ADR 0001) or a cached clip render (WebM, alpha as a second stream,
// ADR 0002, read whole). One shape, so a layer decodes all of them the same way.
import type { SyncTable } from "./decode-plan.js";
import { type ByteReader, openProxy, readSamples } from "./demux.js";
import { openWebm, openWebmProxy, readWebmProxy } from "./webm.js";

/** One encoded picture; index = source frame. */
export interface EncodedPicture {
  data: Uint8Array;
  key: boolean;
  /** Frame of the alpha plane (its luma is the alpha), decoded by a second decoder; null when opaque. */
  alpha: { data: Uint8Array; key: boolean } | null;
}

/** A decodable video file, frame index = sample index (CFR, no reordering). */
export interface VideoSource {
  /** `VideoDecoderConfig` fields, for both the colour and the alpha decoder. */
  config: { codec: string; codedWidth: number; codedHeight: number; description?: Uint8Array; colorSpace?: VideoColorSpaceInit };
  hasAlpha: boolean;
  /** Decode starts: every stream the source has is at a keyframe. */
  table: SyncTable;
  /** Pictures `[from, to)`, clamped to the source. */
  read(from: number, to: number): Promise<EncodedPicture[]>;
}

/** Folder of the daemon's media proxies (SPEC §5.1). */
const PROXIES = ".frameshell/proxies/";

/**
 * Whether {@link openVideoSource} holds the file at `path` in memory whole
 * (a `.webm` clip render), so the engine should drop it once unused.
 */
export function isReadWhole(path: string): boolean {
  return path.toLowerCase().endsWith(".webm") && !path.startsWith(PROXIES);
}

/**
 * Open the project file `path`: `.webm` renders are read whole (they are
 * small); a `.webm` proxy (VP9 with alpha, #90) is indexed from its head and
 * Cues and read by ranges; anything else is an MP4 proxy indexed from its
 * head and read by ranges. Rejects when the file cannot be demuxed.
 */
export async function openVideoSource(path: string, read: ByteReader, readAll: () => Promise<Uint8Array>): Promise<VideoSource> {
  if (path.toLowerCase().endsWith(".webm") && path.startsWith(PROXIES)) {
    const proxy = await openWebmProxy(read);
    return { config: proxy.config, hasAlpha: proxy.hasAlpha, table: proxy.table, read: (from, to) => readWebmProxy(proxy, from, to, read) };
  }
  if (isReadWhole(path)) {
    const render = openWebm(await readAll());
    return {
      config: render.config,
      hasAlpha: render.hasAlpha,
      table: render.table,
      read: async (from, to) => render.frames.slice(Math.max(0, from), Math.min(render.frames.length, to)),
    };
  }
  const proxy = await openProxy(read);
  return {
    config: proxy.config,
    hasAlpha: false,
    table: proxy.table,
    read: async (from, to) => {
      const start = Math.max(0, from);
      const bytes = await readSamples(proxy, start, to, read);
      return bytes.map((data, i) => ({ data, key: proxy.table.isSync(start + i), alpha: null }));
    },
  };
}
