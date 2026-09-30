// MP4 demux of CFR proxies over byte ranges (mp4box.js), for the engine worker's WebCodecs decoder (ADR 0001).
import { DataStream, Endianness, MP4BoxBuffer, createFile } from "mp4box";
import { type SyncTable, syncTable } from "./decode-plan.js";

/** Bytes `[start, end)` of the proxy; fewer at the end of the file. */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

/** `VideoDecoderConfig` fields the proxy provides. */
export interface ProxyDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC record (AVCDecoderConfigurationRecord). */
  description: Uint8Array;
}

/** Where each video sample lives in the file, plus what decoding it needs. */
export interface ProxyIndex {
  config: ProxyDecoderConfig;
  /** Video samples in decode order (= display order: no B-frames); index = source frame. */
  samples: { offset: number; size: number }[];
  table: SyncTable;
}

/** Head read size: a faststart proxy's movie header fits in one read for about an hour of footage. */
const HEAD_BYTES = 1 << 20;

/**
 * Index a proxy: read from the start until the movie header parses (one read
 * for faststart proxies), then list the first video track's samples.
 * Rejects when the file ends first or has no video track.
 */
export async function openProxy(read: ByteReader): Promise<ProxyIndex> {
  const file = createFile();
  let ready = false;
  let failure: string | null = null;
  file.onReady = () => {
    ready = true;
  };
  file.onError = (_module: string, message: string) => {
    failure = message;
  };
  let position = 0;
  while (!ready) {
    const bytes = await read(position, position + HEAD_BYTES);
    if (bytes.length === 0 || failure) throw new Error(`Proxy is not a readable MP4${failure ? `: ${failure}` : " (no movie header)"}`);
    const copy = bytes.slice().buffer;
    position = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(copy, position));
  }
  const track = file.getInfo().videoTracks[0];
  if (!track) throw new Error("Proxy has no video track");
  const trak = file.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as { avcC?: { write(stream: DataStream): void } };
  if (!entry.avcC) throw new Error(`Proxy video is ${track.codec}, not H.264`);
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  entry.avcC.write(stream);
  // Skip the box header (size + type): the decoder wants the bare record.
  const description = new Uint8Array(stream.buffer, 8, stream.getPosition() - 8).slice();
  const samples = file.getTrackSamplesInfo(track.id);
  return {
    config: { codec: track.codec, codedWidth: track.video!.width, codedHeight: track.video!.height, description },
    samples: samples.map((s) => ({ offset: s.offset, size: s.size })),
    table: syncTable(samples.map((s) => s.is_sync)),
  };
}

/** Bytes of samples `[from, to)` (clamped), read with one ranged request: they are nearly contiguous. */
export async function readSamples(proxy: ProxyIndex, from: number, to: number, read: ByteReader): Promise<Uint8Array[]> {
  const list = proxy.samples.slice(Math.max(0, from), Math.min(proxy.samples.length, to));
  if (list.length === 0) return [];
  const start = Math.min(...list.map((s) => s.offset));
  const end = Math.max(...list.map((s) => s.offset + s.size));
  const bytes = await read(start, end);
  return list.map((s) => bytes.subarray(s.offset - start, s.offset - start + s.size));
}
