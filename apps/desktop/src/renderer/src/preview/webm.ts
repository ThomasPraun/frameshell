// WebM demux for the engine worker's WebCodecs decoders: cached clip renders (ADR 0002), small (about 1 MB per 8 s at
// 1440p), parsed whole in memory; and VP9-alpha media proxies (#90), which can be long, indexed by their Cues and read
// by byte ranges like the MP4 proxies (ADR 0001).
import { type SyncTable, syncTable } from "./decode-plan.js";

/** `VideoDecoderConfig` fields a render provides. */
export interface RenderDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /**
   * YUV to RGB rules. Renders are usually untagged, which export's ffmpeg
   * reads as BT.601 limited range; Chromium would guess otherwise, so the
   * preview says so explicitly (primaries and transfer as the proxies').
   */
  colorSpace: { matrix: "bt709" | "smpte170m" | "bt470bg" | "rgb"; primaries: "bt709"; transfer: "bt709"; fullRange: boolean };
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
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  colour: 0x55b0,
  matrixCoefficients: 0x55b1,
  range: 0x55b9,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
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
const MASTERS = new Set<number>([
  ID.segment,
  ID.seekHead,
  ID.seek,
  ID.info,
  ID.tracks,
  ID.trackEntry,
  ID.video,
  ID.colour,
  ID.cues,
  ID.cuePoint,
  ID.cueTrackPositions,
  ID.cluster,
  ID.blockGroup,
  ID.blockAdditions,
]);

interface Element {
  id: number;
  /** Element start (its ID), relative to the buffer. */
  at: number;
  /** Payload `[start, end)`, clamped to the buffer. */
  start: number;
  end: number;
  /** Declared payload size; Infinity when unknown. */
  size: number;
  /** The payload runs past the buffer (or the parent): `end` was clamped. */
  cut: boolean;
}

interface Track {
  number: number;
  video: boolean;
  codec: string;
  width: number;
  height: number;
  /** Matroska `MatrixCoefficients` (ISO/IEC 23091-4); 2 = unspecified. */
  matrix: number;
  /** Matroska `Range`: 2 = full; anything else is limited (broadcast) range. */
  range: number;
  /** Frame duration, ns; 0 when not stored. */
  defaultDuration: number;
}

/** A video or audio block; `time` in timestamp-scale units (cluster time + block offset). */
interface Block {
  track: number;
  time: number;
  data: Uint8Array;
  alpha: Uint8Array | null;
  /** The block runs past the bytes read: never a frame. */
  cut: boolean;
}

/** Everything one pass over some WebM bytes found. Positions are relative to the buffer. */
interface Parsed {
  tracks: Track[];
  blocks: Block[];
  /** Payload start of the Segment; null when the bytes hold no Segment header. */
  segmentStart: number | null;
  /** Declared payload end of the Segment; Infinity when its size is unknown. */
  segmentEnd: number;
  /** ns per timestamp unit (Matroska default 1 ms). */
  timestampScale: number;
  /** Segment duration in timestamp units; null when not stored. */
  duration: number | null;
  /** SeekHead entries: element ID to position relative to the Segment payload. */
  seeks: Map<number, number>;
  /** Cue points: time (timestamp units), track, cluster position relative to the Segment payload. */
  cues: { time: number; track: number; cluster: number }[];
  /** Start of the first Cluster met; null when none. */
  firstCluster: number | null;
}

/** Matroska matrix code to WebCodecs; unspecified reads as BT.601, as ffmpeg's default conversion does. */
function matrixOf(code: number): RenderDecoderConfig["colorSpace"]["matrix"] {
  if (code === 0) return "rgb";
  if (code === 1) return "bt709";
  if (code === 5) return "bt470bg";
  return "smpte170m";
}

/**
 * Walk WebM bytes in one pass. With `headOnly` the walk stops at the first
 * Cluster (its blocks may not be in the buffer yet).
 */
function parse(bytes: Uint8Array, headOnly: boolean): Parsed {
  const out: Parsed = {
    tracks: [],
    blocks: [],
    segmentStart: null,
    segmentEnd: Infinity,
    timestampScale: 1_000_000,
    duration: null,
    seeks: new Map(),
    cues: [],
    firstCluster: null,
  };
  let clusterTime = 0;
  let seek = { id: 0, position: -1 };
  let cue = { time: 0, track: 0, cluster: -1 };
  let stopped = false;

  const walk = (from: number, to: number, parent: number | null): void => {
    for (let at = from; at < to && !stopped; ) {
      const element = readElement(bytes, at, to);
      if (!element) return;
      at = element.end;
      const { id, start, end } = element;
      if (MASTERS.has(id)) {
        if (id === ID.cluster) {
          out.firstCluster ??= element.at;
          if (headOnly) {
            stopped = true;
            return;
          }
        }
        if (id === ID.segment && out.segmentStart === null) {
          out.segmentStart = start;
          out.segmentEnd = start + element.size;
        }
        if (id === ID.trackEntry) {
          out.tracks.push({ number: 0, video: false, codec: "", width: 0, height: 0, matrix: 2, range: 0, defaultDuration: 0 });
        }
        if (id === ID.blockGroup) out.blocks.push({ track: -1, time: 0, data: new Uint8Array(0), alpha: null, cut: element.cut });
        if (id === ID.seek) seek = { id: 0, position: -1 };
        if (id === ID.cueTrackPositions) cue = { ...cue, track: 0, cluster: -1 };
        walk(start, end, id);
        if (id === ID.seek && seek.position >= 0) out.seeks.set(seek.id, seek.position);
        if (id === ID.cueTrackPositions && cue.cluster >= 0) out.cues.push({ ...cue });
        continue;
      }
      const track = out.tracks.at(-1);
      switch (id) {
        case ID.seekId:
          seek.id = readUint(bytes, start, end);
          break;
        case ID.seekPosition:
          seek.position = readUint(bytes, start, end);
          break;
        case ID.timestampScale:
          out.timestampScale = readUint(bytes, start, end) || 1_000_000;
          break;
        case ID.duration:
          out.duration = readFloat(bytes, start, end);
          break;
        case ID.cueTime:
          cue.time = readUint(bytes, start, end);
          break;
        case ID.cueTrack:
          cue.track = readUint(bytes, start, end);
          break;
        case ID.cueClusterPosition:
          cue.cluster = readUint(bytes, start, end);
          break;
        case ID.trackNumber:
          if (track) track.number = readUint(bytes, start, end);
          break;
        case ID.trackType:
          if (track) track.video = readUint(bytes, start, end) === 1;
          break;
        case ID.codecId:
          if (track) track.codec = new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0+$/, "");
          break;
        case ID.defaultDuration:
          if (track) track.defaultDuration = readUint(bytes, start, end);
          break;
        case ID.pixelWidth:
          if (track) track.width = readUint(bytes, start, end);
          break;
        case ID.pixelHeight:
          if (track) track.height = readUint(bytes, start, end);
          break;
        case ID.matrixCoefficients:
          if (track) track.matrix = readUint(bytes, start, end);
          break;
        case ID.range:
          if (track) track.range = readUint(bytes, start, end);
          break;
        case ID.timecode:
          if (parent === ID.cluster) clusterTime = readUint(bytes, start, end);
          break;
        case ID.simpleBlock: {
          const block = readBlock(bytes, start, end);
          if (block) out.blocks.push({ track: block.track, time: clusterTime + block.offset, data: block.data, alpha: null, cut: element.cut });
          break;
        }
        case ID.block: {
          const block = readBlock(bytes, start, end);
          const group = out.blocks.at(-1);
          if (block && group) {
            Object.assign(group, { track: block.track, time: clusterTime + block.offset, data: block.data, cut: group.cut || element.cut });
          }
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
          const group = out.blocks.at(-1);
          if (group && addId === 1 && additional) group.alpha = additional;
          break;
        }
      }
    }
  };
  const header = readElement(bytes, 0, bytes.length);
  if (header?.id !== ID.ebml) throw new Error("Not a WebM file");
  walk(header.end, bytes.length, null);
  return out;
}

/** The first VP8/VP9 video track; throws when there is none. */
function videoTrack(tracks: readonly Track[], what: string): Track {
  const track = tracks.find((t) => t.video && /^V_VP[89]$/.test(t.codec));
  if (!track) throw new Error(`${what} has no video frames (VP8 or VP9 WebM expected)`);
  return track;
}

/** Frames of `track` among `blocks`, by time; cut blocks dropped. */
function framesOf(track: Pick<Track, "number" | "codec">, blocks: readonly Block[]): (RenderFrame & { time: number })[] {
  const vp9 = track.codec === "V_VP9";
  const keyOf = (data: Uint8Array) => (vp9 ? vp9Keyframe(data) : (data[0]! & 1) === 0);
  return blocks
    .filter((b) => b.track === track.number && !b.cut && b.data.length > 0)
    .sort((a, b) => a.time - b.time)
    .map((b) => ({
      time: b.time,
      data: b.data,
      key: keyOf(b.data),
      alpha: b.alpha && b.alpha.length > 0 ? { data: b.alpha, key: keyOf(b.alpha) } : null,
    }));
}

/** Decoder config of `track`; `first` is a frame of it (the VP9 profile is in the bitstream). */
function configOf(track: Track, first: Uint8Array | null): RenderDecoderConfig {
  const vp9 = track.codec === "V_VP9";
  const profile = vp9 && first ? vp9Profile(first) : 0;
  return {
    codec: vp9 ? `vp09.0${profile}.10.${profile >= 2 ? "10" : "08"}` : "vp8",
    codedWidth: track.width,
    codedHeight: track.height,
    colorSpace: { matrix: matrixOf(track.matrix), primaries: "bt709", transfer: "bt709", fullRange: track.range === 2 },
  };
}

/**
 * Demux a WebM render: the first video track's frames, with their alpha
 * frames. Throws when the bytes are not WebM, or hold no VP8/VP9 video frames.
 */
export function openWebm(bytes: Uint8Array): RenderIndex {
  if (readElement(bytes, 0, bytes.length)?.id !== ID.ebml) throw new Error("Render is not a WebM file");
  const parsed = parse(bytes, false);
  const track = videoTrack(parsed.tracks, "Render");
  const frames: RenderFrame[] = framesOf(track, parsed.blocks).map(({ data, key, alpha }) => ({ data, key, alpha }));
  if (frames.length === 0) throw new Error("Render has no video frames (VP8 or VP9 WebM expected)");
  const hasAlpha = frames.some((f) => f.alpha !== null);
  return {
    config: configOf(track, frames[0]!.data),
    hasAlpha,
    frames,
    table: syncTable(frames.map((f) => f.key && (!hasAlpha || f.alpha?.key === true))),
  };
}

/** Bytes `[start, end)` of a file; fewer at its end. */
export type WebmByteReader = (start: number, end: number) => Promise<Uint8Array>;

/** A CFR WebM proxy indexed from its head and Cues, read by byte ranges with {@link readWebmProxy}. */
export interface WebmProxyIndex {
  config: RenderDecoderConfig;
  hasAlpha: boolean;
  /** Decode starts: the cued keyframes (the recipe forces colour and alpha keyframes together). */
  table: SyncTable;
  /** Cued keyframes in frame order: frame index and absolute position of the Cluster holding it. */
  keyframes: { frame: number; cluster: number }[];
  /** File offset where frame data ends: the Cues after the last Cluster, else the Segment end. */
  mediaEnd: number;
  /** Frame duration in timestamp units: frame index = round(time / frameTime). */
  frameTime: number;
  /** Matroska number and codec ID of the video track. */
  track: { number: number; codec: string };
}

/** Head read size: EBML header, SeekHead, Info, Tracks of a proxy, with room to spare. */
const WEBM_HEAD_BYTES = 64 << 10;
/** Largest EBML element header: 4-byte ID, 8-byte size. */
const MAX_HEADER = 12;

/**
 * Index a CFR WebM proxy (#90: VP9 with alpha) without reading its frames
 * beyond the first: the head gives track, frame duration and Segment
 * duration; the Cues (found through the SeekHead when not in the head) give
 * every keyframe's Cluster. Frame index = time / frame duration, so the proxy
 * must be CFR from time 0, as the ingest recipe guarantees. Rejects when any
 * of that is missing.
 */
export async function openWebmProxy(read: WebmByteReader): Promise<WebmProxyIndex> {
  const head = await read(0, WEBM_HEAD_BYTES);
  const parsed = parse(head, true);
  if (parsed.segmentStart === null) throw new Error("Proxy is not a readable WebM (no Segment)");
  const segment = parsed.segmentStart;
  const track = videoTrack(parsed.tracks, "Proxy");
  if (track.defaultDuration <= 0 || parsed.duration === null) throw new Error("Proxy WebM has no frame or segment duration");
  const frameTime = track.defaultDuration / parsed.timestampScale;

  let cues = parsed.cues;
  const cuesAt = parsed.seeks.get(ID.cues);
  if (cues.length === 0 && cuesAt !== undefined) {
    const at = segment + cuesAt;
    const element = readElement(await read(at, at + MAX_HEADER), 0, Infinity);
    if (element?.id !== ID.cues || element.size === Infinity) throw new Error("Proxy WebM SeekHead does not point at its Cues");
    cues = parse(concat(EMPTY_EBML, await read(at, element.start + element.size + at)), false).cues;
  }
  const keyframes = cues
    .filter((c) => c.track === track.number)
    .map((c) => ({ frame: Math.round(c.time / frameTime), cluster: segment + c.cluster }))
    .sort((x, y) => x.frame - y.frame);
  if (keyframes[0]?.frame !== 0) throw new Error("Proxy WebM has no Cues for its keyframes");
  const count = Math.max(Math.round(parsed.duration / frameTime), keyframes.at(-1)!.frame + 1);
  const sync = new Array<boolean>(count).fill(false);
  for (const k of keyframes) sync[k.frame] = true;

  const lastCluster = keyframes.at(-1)!.cluster;
  const mediaEnd = cuesAt !== undefined && segment + cuesAt > lastCluster ? segment + cuesAt : parsed.segmentEnd;
  if (!Number.isFinite(mediaEnd)) throw new Error("Proxy WebM has a Segment of unknown size and no Cues after its frames");
  const index: WebmProxyIndex = {
    config: configOf(track, null),
    hasAlpha: false,
    table: syncTable(sync),
    keyframes,
    mediaEnd,
    frameTime,
    track: { number: track.number, codec: track.codec },
  };
  // The VP9 profile and whether there is alpha live in the frames: read the first one.
  const [first] = await readWebmProxy(index, 0, 1, read);
  index.config = configOf(track, first!.data);
  index.hasAlpha = first!.alpha !== null;
  return index;
}

/**
 * Frames `[from, to)` of a proxy from {@link openWebmProxy}, clamped, with
 * one ranged read: from the Cluster of the keyframe at or before `from` to
 * the next cued Cluster past the last frame wanted. Rejects when a frame is
 * missing (a proxy that is not CFR from time 0).
 */
export async function readWebmProxy(index: WebmProxyIndex, from: number, to: number, read: WebmByteReader): Promise<RenderFrame[]> {
  const start = Math.max(0, from);
  const end = Math.min(index.table.count, to);
  if (end <= start) return [];
  const { keyframes } = index;
  const keyAt = (frame: number) => keyframes[keyframes.findLastIndex((k) => k.frame <= frame)]!;
  const begin = keyAt(start).cluster;
  // A Cluster may start mid-GOP (ffmpeg splits long ones by time), so frames before a cued keyframe can share its
  // Cluster: try the next cued Cluster past the last wanted keyframe's, then later ones, then the end.
  const last = keyAt(end - 1).cluster;
  const stops = [...new Set(keyframes.map((k) => k.cluster).filter((c) => c > last)), index.mediaEnd];
  let missing = start;
  for (const stop of stops) {
    const parsed = parse(concat(EMPTY_EBML, await read(begin, stop)), false);
    const byFrame = new Map<number, RenderFrame>();
    for (const { time, ...frame } of framesOf(index.track, parsed.blocks)) {
      const i = Math.round(time / index.frameTime);
      if (i >= start && i < end) byFrame.set(i, frame);
    }
    const frames: RenderFrame[] = [];
    for (let i = start; i < end && byFrame.has(i); i++) frames.push(byFrame.get(i)!);
    if (frames.length === end - start) return frames;
    missing = start + frames.length;
  }
  throw new Error(`Proxy WebM has no frame ${missing}`);
}

/** Smallest EBML header (no children): lets {@link parse} walk a slice that starts at a Cluster or the Cues. */
const EMPTY_EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
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
  const bound = Math.min(limit, bytes.length);
  if (start > bound) return null;
  // Unknown size (all ones): runs to the parent's end.
  const declared = size.unknown ? Infinity : start + size.value;
  return { id: id.id, at, start, end: Math.min(bound, declared), size: declared - start, cut: declared !== Infinity && declared > bound };
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

/** EBML float: 4 or 8 bytes big-endian; 0 for an empty payload. */
function readFloat(bytes: Uint8Array, start: number, end: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start === 4) return view.getFloat32(0);
  if (end - start === 8) return view.getFloat64(0);
  return 0;
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i]!;
  return value;
}
