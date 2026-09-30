// WebM demux of cached clip renders (ADR 0002), for the engine worker's WebCodecs decoders. Renders are small (about
// 1 MB per 8 s at 1440p), so the whole file is parsed in memory.
import { type SyncTable, syncTable } from "./decode-plan.js";

/** `VideoDecoderConfig` fields a render provides. */
export interface RenderDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
}

/** One encoded picture: the colour frame and, when the render has alpha, the alpha plane's own frame. */
export interface RenderFrame {
  data: Uint8Array;
  key: boolean;
  /** VP9/VP8 frame whose luma is the alpha plane (Matroska `BlockAdditional` 1); null when opaque. */
  alpha: { data: Uint8Array; key: boolean } | null;
}

/** A demuxed render. Colour and alpha streams share one config. */
export interface RenderIndex {
  config: RenderDecoderConfig;
  hasAlpha: boolean;
  /** In display order (no reordering in VP8/VP9 WebM): index = render frame. */
  frames: RenderFrame[];
  /** Decode starts: frames where colour and alpha are both keyframes. */
  table: SyncTable;
}

const ID = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockAdditions: 0x75a1,
  blockMore: 0xa6,
  blockAddId: 0xee,
  blockAdditional: 0xa5,
} as const;

/** Masters whose children the parser walks; everything else is skipped by size. */
const MASTERS = new Set<number>([ID.segment, ID.tracks, ID.trackEntry, ID.video, ID.cluster, ID.blockGroup, ID.blockAdditions]);

interface Element {
  id: number;
  /** Payload `[start, end)`, clamped to the buffer. */
  start: number;
  end: number;
}

interface Track {
  number: number;
  video: boolean;
  codec: string;
  width: number;
  height: number;
}

/**
 * Demux a WebM render: the first video track's frames, with their alpha
 * frames. Throws when the bytes are not WebM, or hold no VP8/VP9 video frames.
 */
export function openWebm(bytes: Uint8Array): RenderIndex {
  const header = readElement(bytes, 0, bytes.length);
  if (header?.id !== 0x1a45dfa3) throw new Error("Render is not a WebM file");
  const tracks: Track[] = [];
  const blocks: { track: number; time: number; data: Uint8Array; alpha: Uint8Array | null }[] = [];
  let clusterTime = 0;

  const walk = (from: number, to: number, parent: number | null): void => {
    for (let at = from; at < to; ) {
      const element = readElement(bytes, at, to);
      if (!element) return;
      at = element.end;
      const { id, start, end } = element;
      if (MASTERS.has(id)) {
        if (id === ID.trackEntry) tracks.push({ number: 0, video: false, codec: "", width: 0, height: 0 });
        if (id === ID.blockGroup) blocks.push({ track: -1, time: 0, data: new Uint8Array(0), alpha: null });
        walk(start, end, id);
        continue;
      }
      const track = tracks.at(-1);
      switch (id) {
        case ID.trackNumber:
          if (track) track.number = readUint(bytes, start, end);
          break;
        case ID.trackType:
          if (track) track.video = readUint(bytes, start, end) === 1;
          break;
        case ID.codecId:
          if (track) track.codec = new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0+$/, "");
          break;
        case ID.pixelWidth:
          if (track) track.width = readUint(bytes, start, end);
          break;
        case ID.pixelHeight:
          if (track) track.height = readUint(bytes, start, end);
          break;
        case ID.timecode:
          if (parent === ID.cluster) clusterTime = readUint(bytes, start, end);
          break;
        case ID.simpleBlock: {
          const block = readBlock(bytes, start, end);
          if (block) blocks.push({ track: block.track, time: clusterTime + block.offset, data: block.data, alpha: null });
          break;
        }
        case ID.block: {
          const block = readBlock(bytes, start, end);
          const group = blocks.at(-1);
          if (block && group) Object.assign(group, { track: block.track, time: clusterTime + block.offset, data: block.data });
          break;
        }
        case ID.blockMore: {
          // BlockAddID defaults to 1: the alpha plane (Matroska `AlphaMode`). Other additions are not alpha.
          let addId = 1;
          let additional: Uint8Array | null = null;
          for (let child = readElement(bytes, start, end); child; child = readElement(bytes, child.end, end)) {
            if (child.id === ID.blockAddId) addId = readUint(bytes, child.start, child.end);
            else if (child.id === ID.blockAdditional) additional = bytes.subarray(child.start, child.end);
          }
          const group = blocks.at(-1);
          if (group && addId === 1 && additional) group.alpha = additional;
          break;
        }
      }
    }
  };
  walk(header.end, bytes.length, null);

  const track = tracks.find((t) => t.video && /^V_VP[89]$/.test(t.codec));
  const own = track ? blocks.filter((b) => b.track === track.number && b.data.length > 0).sort((a, b) => a.time - b.time) : [];
  if (!track || own.length === 0) throw new Error("Render has no video frames (VP8 or VP9 WebM expected)");
  const vp9 = track.codec === "V_VP9";
  const keyOf = (data: Uint8Array) => (vp9 ? vp9Keyframe(data) : (data[0]! & 1) === 0);
  const frames: RenderFrame[] = own.map((b) => ({
    data: b.data,
    key: keyOf(b.data),
    alpha: b.alpha && b.alpha.length > 0 ? { data: b.alpha, key: keyOf(b.alpha) } : null,
  }));
  const hasAlpha = frames.some((f) => f.alpha !== null);
  const profile = vp9 ? vp9Profile(frames[0]!.data) : 0;
  return {
    config: { codec: vp9 ? `vp09.0${profile}.10.${profile >= 2 ? "10" : "08"}` : "vp8", codedWidth: track.width, codedHeight: track.height },
    hasAlpha,
    frames,
    table: syncTable(frames.map((f) => f.key && (!hasAlpha || f.alpha?.key === true))),
  };
}

/** VP9 uncompressed header: key frame (frame_type 0) that is not a show-existing-frame. */
function vp9Keyframe(data: Uint8Array): boolean {
  const byte = data[0];
  if (byte === undefined || byte >> 6 !== 2) return false;
  const profile = vp9Profile(data);
  const bit = profile === 3 ? 2 : 3;
  const showExisting = (byte >> bit) & 1;
  const frameType = (byte >> (bit - 1)) & 1;
  return showExisting === 0 && frameType === 0;
}

function vp9Profile(data: Uint8Array): number {
  const byte = data[0] ?? 0;
  return ((byte >> 5) & 1) | (((byte >> 4) & 1) << 1);
}

/** Matroska (Simple)Block payload: track, timecode offset, flags; laced blocks are not supported (never used for video). */
function readBlock(bytes: Uint8Array, start: number, end: number): { track: number; offset: number; data: Uint8Array } | null {
  const track = readVint(bytes, start);
  if (!track || track.next + 3 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + track.next, 3);
  if ((view.getUint8(2) & 0x06) !== 0) throw new Error("Render uses laced video blocks, which the preview cannot read");
  return { track: track.value, offset: view.getInt16(0), data: bytes.subarray(track.next + 3, end) };
}

function readElement(bytes: Uint8Array, at: number, limit: number): Element | null {
  const id = readId(bytes, at);
  if (!id) return null;
  const size = readVint(bytes, id.next);
  if (!size) return null;
  const start = size.next;
  if (start > limit) return null;
  // Unknown size (all ones): runs to the parent's end.
  const end = size.unknown ? limit : Math.min(limit, start + size.value);
  return { id: id.id, start, end };
}

/** Element ID: a vint with its length marker kept. */
function readId(bytes: Uint8Array, at: number): { id: number; next: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 4 || at + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i]!;
  return { id, next: at + length };
}

/** Size or track number: a vint with its length marker cleared. */
function readVint(bytes: Uint8Array, at: number): { value: number; unknown: boolean; next: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    ones &&= byte === 0xff;
  }
  return { value, unknown: ones, next: at + length };
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i]!;
  return value;
}
