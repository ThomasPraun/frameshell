// What the engine worker decodes a layer's pictures from: a media proxy (MP4, read by byte ranges, ADR 0001) or a
// cached clip render (WebM, alpha as a second stream, ADR 0002). One shape, so a layer decodes both the same way.
import type { SyncTable } from "./decode-plan.js";
import { type ByteReader, openProxy, readSamples } from "./demux.js";
import { openWebm } from "./webm.js";

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

/**
 * Open the project file `path`: `.webm` renders are read whole (they are
 * small), anything else is an MP4 proxy indexed from its head and read by
 * ranges. Rejects when the file cannot be demuxed.
 */
export async function openVideoSource(path: string, read: ByteReader, readAll: () => Promise<Uint8Array>): Promise<VideoSource> {
  if (path.toLowerCase().endsWith(".webm")) {
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
