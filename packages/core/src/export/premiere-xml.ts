import { posix, win32 } from "node:path";
import { type Clip, type ClipTrack, type Timeline, type TransitionContext, edgeTransitions } from "@frameshell/schema";
import {
  Dropped,
  LETTERBOX_NOTICE,
  type Placement,
  baseName,
  behindNotice,
  encodePath,
  leftOut,
  missingMedia,
  noLengthNotice,
  placeClip,
  skippedTrackNotice,
} from "./handoff.js";
import { mirrorsSound } from "./otio.js";

/**
 * Premiere Pro XML export (ADR 0047): a Frameshell timeline as an `xmeml` file, the Final Cut Pro 7 interchange
 * format Premiere reads. Pure and export-only: the file is derived and never read back (SPEC decision 3).
 */

/** The `xmeml` version written. One constant, so version 5 can follow. */
export const XMEML_VERSION = 4;

/** Sample rate and bit depth written for the sequence and for a file whose audio is not known: Premiere's own defaults. */
const SEQUENCE_SAMPLE_RATE = 48_000;
const SEQUENCE_DEPTH = 16;

/** What an asset is, as far as it could be read; every field is optional and an absent one is left out of the file. */
export interface PremiereAssetInfo {
  /** Seconds of the file. Absent when unknown; infinite for a still image. */
  seconds?: number | undefined;
  /** True for a still image, an SVG or a font: no sound to mirror. */
  silent?: boolean | undefined;
  /** Picture size in pixels; absent for an audio file or an unread one. */
  width?: number | undefined;
  height?: number | undefined;
  /** First audio stream; absent when silent or unread. */
  audio?: { channels: number; sampleRate: number } | undefined;
}

/** Options of {@link timelineToPremiereXml}. */
export interface PremiereXmlOptions {
  /** Project frames per second: the rate of every time in the file. */
  fps: number;
  /** Picture size of the sequence: the primary format. */
  size: { width: number; height: number };
  /** Name of the sequence. Default: the timeline id. */
  name?: string | undefined;
  /** `pathurl` of a project-relative asset path. */
  assetUrl(asset: string): string;
  /** Seconds of material a clip draws from; see `TransitionContext.sourceDuration`. */
  sourceDuration?: ((clip: Clip) => number | undefined) | undefined;
  /** Facts about a media asset. Default: nothing known, every media asset taken to have sound. */
  assetInfo?: ((asset: string) => PremiereAssetInfo | undefined) | undefined;
}

/** What {@link timelineToPremiereXml} returns. */
export interface PremiereXmlExport {
  /** The whole file, ready to write. */
  xml: string;
  /** One line per thing the file does not carry. */
  warnings: string[];
  /** Video and audio tracks written, the sound mirror tracks included. */
  tracks: number;
  /** Picture clips written, offline ones included; their sound is not counted. */
  clips: number;
  /** Markers written. */
  markers: number;
}

/** A clip that plays a project file. */
type AssetClip = Extract<Clip, { asset: string }>;

/** A node of the XML tree:the file is built as data and printed once. */
interface Node {
  name: string;
  attrs?: Record<string, string>;
  text?: string;
  kids?: Node[];
}

/** Printed as the empty element `<name/>` when it has neither text nor children. */
function el(name: string, content: string | number | (Node | undefined)[], attrs?: Record<string, string>): Node {
  const node: Node = { name };
  if (attrs) node.attrs = attrs;
  if (Array.isArray(content)) node.kids = content.filter((kid): kid is Node => kid !== undefined);
  else node.text = String(content);
  return node;
}

const bool = (value: boolean) => (value ? "TRUE" : "FALSE");

/** XML text: the five entities, and no character XML 1.0 cannot hold. */
export function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- the point: these are the characters XML 1.0 forbids
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function print(node: Node, depth: number, lines: string[]): void {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  if (node.kids !== undefined && node.kids.length > 0) {
    lines.push(`${pad}<${node.name}${attrs}>`);
    for (const kid of node.kids) print(kid, depth + 1, lines);
    lines.push(`${pad}</${node.name}>`);
  } else if (node.text !== undefined && node.text !== "") {
    lines.push(`${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`);
  } else {
    lines.push(`${pad}<${node.name}${attrs}/>`);
  }
}

/** The 1000/1001 rates xmeml writes as a whole timebase with `ntsc` TRUE. */
const NTSC_TIMEBASES = [24, 30, 48, 60, 120];

/** `<rate>` of `fps`: `timebase` and `ntsc`. `exact` is false for a rate xmeml cannot name (it is then written at the nearest whole one). */
function rateOf(fps: number): { timebase: number; ntsc: boolean; exact: boolean } {
  const ntsc = NTSC_TIMEBASES.find((base) => Math.abs(fps - (base * 1000) / 1001) < 0.002);
  if (ntsc !== undefined) return { timebase: ntsc, ntsc: true, exact: true };
  return { timebase: Math.round(fps), ntsc: false, exact: Number.isInteger(fps) };
}

function rateNode(fps: number): Node {
  const { timebase, ntsc } = rateOf(fps);
  return el("rate", [el("timebase", timebase), el("ntsc", bool(ntsc))]);
}

/** One `<clipitem>`; a picture and its sound are partners, and each lists both as its `<link>`s, itself included, as Premiere writes it. */
interface Item {
  id: string;
  clip: Clip;
  place: Placement;
  /** The video track clip of a mirror clip, or the mirror clip of a picture clip. */
  partner?: Item;
  /** Dissolve joining this item to the one before it: the half length in frames. */
  dissolveHalf?: number;
  trackIndex: number;
  clipIndex: number;
  mediaType: "video" | "audio";
}

interface BuiltTrack {
  mediaType: "video" | "audio";
  enabled: boolean;
  items: Item[];
}

/**
 * The xmeml document of `timeline` (ADR 0047): `xmeml` version {@link XMEML_VERSION}, one `<sequence>` at the project
 * rate with video and audio tracks bottom first, media clips as `<clipitem>`s of a `<file>` with an absolute `pathurl`
 * (`in` and `out` in source frames, `start` and `end` in timeline frames, a Time Remap filter for `speed`), generated and
 * nested clips as clipitems with an offline `<file>` of their length, markers on the sequence, dissolves between butted
 * clips as Cross Dissolve `<transitionitem>`s (`edgeTransitions` decides which, never recomputed here). Every time is a
 * whole frame. The sound of the media clips of each video track is a linked audio clipitem on an extra Audio track after
 * all the real ones (xmeml links a picture and its sound natively): disabled where the clip or the track is muted. A
 * clip's `audio.gain` is an Audio Levels filter on its audio clipitem.
 * `clips` counts the pictures, not their sound. Program tracks, subtitle tracks, dips and fades, transition shapes,
 * transforms, keys, grades, film finish, audio effects and sound fades are left out and named in `warnings`.
 */
export function timelineToPremiereXml(timeline: Timeline, options: PremiereXmlOptions): PremiereXmlExport {
  const { fps } = options;
  const context: TransitionContext = { fps, ...(options.sourceDuration ? { sourceDuration: options.sourceDuration } : {}) };
  const warnings: string[] = [];
  const dropped = new Dropped();
  const info = (asset: string) => options.assetInfo?.(asset);
  const hasSound = (asset: string) => info(asset)?.silent !== true;
  const rate = rateOf(fps);
  if (!rate.exact) warnings.push(`frame rate ${fps} is not one xmeml can name: times are written at ${rate.timebase} fps and drift against the media.`);

  const videos: BuiltTrack[] = [];
  const audios: BuiltTrack[] = [];
  const picturesOf = new Map<BuiltTrack, ClipTrack>();
  let clipCount = 0;

  /** The items of one track; `sound`: the mirror of a video track, media clips with sound only. */
  const build = (track: ClipTrack, sound: boolean): BuiltTrack => {
    const items: Item[] = [];
    const edges = edgeTransitions(track.clips, context);
    let cursor = -1;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (sound && !mirrorsSound(clip, hasSound)) continue;
      const place = placeClip(clip, context, fps);
      if (place === undefined) {
        warnings.push(noLengthNotice(clip));
        continue;
      }
      const edge = edges.get(clip.id);
      // A transition sits between two clipitems whose frame positions meet: the butted clips the dissolve was cut for.
      const joined = edge?.mode === "dissolve" && edge.dissolve > 0 && items.length > 0 && place.startFrames <= cursor;
      const item: Item = { id: "", clip, place, trackIndex: 0, clipIndex: 0, mediaType: sound || track.kind === "audio" ? "audio" : "video" };
      if (joined) item.dissolveHalf = Math.max(1, Math.round(edge.dissolve * fps));
      items.push(item);
      cursor = Math.max(cursor, place.endFrames);
      if (!sound) {
        // The level goes on the audio clip item of a clip with sound; a clip with none has nothing to level.
        leftOut(clip, dropped, joined, "asset" in clip && !hasSound(clip.asset) ? "not exported" : undefined);
        if ("asset" in clip && hasSound(clip.asset) && (staticGain(clip) ?? 0) > MAX_GAIN_DB) {
          dropped.add(`clip gain above +${MAX_GAIN_DB} dB (audio.gain)`, clip.id, `written as +${MAX_GAIN_DB} dB, the most an Audio Levels filter holds`);
        }
        if (!("asset" in clip)) warnings.push(missingMedia(clip).warning);
        clipCount += 1;
      }
    }
    const behind = sound ? undefined : behindNotice(track);
    if (behind !== undefined) warnings.push(behind);
    const muted = track.muted === true;
    // A muted video track keeps its picture: its sound is on the mirror track, which is the one disabled.
    const enabled = sound || track.kind === "audio" ? !muted : track.hidden !== true;
    const built: BuiltTrack = { mediaType: sound || track.kind === "audio" ? "audio" : "video", enabled, items };
    picturesOf.set(built, track);
    return built;
  };

  const videoSources: { built: BuiltTrack; track: ClipTrack }[] = [];
  for (const track of timeline.tracks) {
    const skipped = skippedTrackNotice(track);
    if (skipped !== undefined) {
      warnings.push(skipped);
      continue;
    }
    if (track.kind === "program" || track.kind === "subtitles") continue;
    const built = build(track, false);
    if (track.kind === "video") {
      videos.push(built);
      videoSources.push({ built, track });
    } else {
      audios.push(built);
    }
  }
  // After every real audio track, so the ordinals of the real ones are what they are without the mirrors.
  const mirrors: { built: BuiltTrack; picture: BuiltTrack }[] = [];
  for (const { built: picture, track } of videoSources) {
    const sound = build(track, true);
    if (sound.items.length === 0) continue;
    mirrors.push({ built: sound, picture });
    audios.push(sound);
  }
  if (timeline.letterbox !== undefined) warnings.push(LETTERBOX_NOTICE);

  // Ids and positions in document order: video first, so a file is defined where its picture is and referenced by its sound.
  let itemCount = 0;
  for (const tracks of [videos, audios]) {
    tracks.forEach((built, trackIndex) => {
      built.items.forEach((item, clipIndex) => {
        itemCount += 1;
        item.id = `clipitem-${itemCount}`;
        item.trackIndex = trackIndex + 1;
        item.clipIndex = clipIndex + 1;
      });
    });
  }
  for (const { built, picture } of mirrors) {
    for (const item of built.items) {
      const twin = picture.items.find((candidate) => candidate.clip.id === item.clip.id);
      if (twin !== undefined) {
        item.partner = twin;
        twin.partner = item;
      }
    }
  }

  // The longest each file is played to, for a file whose length is not known.
  const reached = new Map<string, number>();
  for (const built of [...videos, ...audios]) {
    for (const item of built.items) {
      if (!("asset" in item.clip)) continue;
      reached.set(item.clip.asset, Math.max(reached.get(item.clip.asset) ?? 0, sourceFrames(item.clip, item.place, fps).out));
    }
  }

  /** Frames of a file: its length when known, else as far as the timeline plays it (a still image has no end). */
  const durationOf = (asset: string): number => {
    const seconds = info(asset)?.seconds;
    const played = reached.get(asset) ?? 0;
    return seconds !== undefined && Number.isFinite(seconds) ? Math.max(Math.round(seconds * fps), played) : played;
  };
  const defined = new Set<string>();
  const fileIds = new Map<string, string>();
  const fileOf = (item: Item): Node => {
    const clip = item.clip;
    if (!("asset" in clip)) return el("file", [el("name", missingMedia(clip).name)], { id: `file-${item.id}` });
    let id = fileIds.get(clip.asset);
    if (id === undefined) {
      id = `file-${fileIds.size + 1}`;
      fileIds.set(clip.asset, id);
    }
    if (defined.has(id)) return el("file", [], { id });
    defined.add(id);
    const facts = info(clip.asset);
    const duration = durationOf(clip.asset);
    const video = facts?.width !== undefined && facts.height !== undefined;
    const media =
      video || facts?.audio !== undefined
        ? el("media", [
            video
              ? el("video", [
                  el("samplecharacteristics", [
                    rateNode(fps),
                    el("width", facts.width!),
                    el("height", facts.height!),
                    el("anamorphic", "FALSE"),
                    el("pixelaspectratio", "square"),
                    el("fielddominance", "none"),
                  ]),
                ])
              : undefined,
            facts?.audio !== undefined
              ? el("audio", [
                  el("samplecharacteristics", [el("depth", SEQUENCE_DEPTH), el("samplerate", facts.audio.sampleRate)]),
                  el("channelcount", facts.audio.channels),
                ])
              : undefined,
          ])
        : undefined;
    return el(
      "file",
      [el("name", baseName(clip.asset)), el("pathurl", options.assetUrl(clip.asset)), rateNode(fps), el("duration", duration), timecodeNode(fps), media],
      { id },
    );
  };

  const clipitem = (item: Item): Node => {
    const clip = item.clip;
    const audio = item.mediaType === "audio";
    const media = "asset" in clip;
    const speed = media ? (clip.speed ?? 1) : 1;
    const source = media ? sourceFrames(clip, item.place, fps) : { in: 0, out: item.place.lengthFrames };
    // A clip muted on an audio track, or whose sound is the mirror, is a disabled slot; a muted clip on a video track keeps its picture.
    const enabled = !(audio && clip.audio?.muted === true);
    const links = item.partner === undefined ? [] : [item, item.partner].sort((a, b) => (a.mediaType === b.mediaType ? 0 : a.mediaType === "video" ? -1 : 1));
    return el(
      "clipitem",
      [
        el("name", media ? baseName(clip.asset) : missingMedia(clip).name),
        el("enabled", bool(enabled)),
        el("duration", media ? durationOf(clip.asset) : item.place.lengthFrames),
        rateNode(fps),
        el("start", item.place.startFrames),
        el("end", item.place.endFrames),
        el("in", source.in),
        el("out", source.out),
        fileOf(item),
        speed === 1 ? undefined : timeRemap(speed, audio ? "audio" : "video"),
        audio && media && staticGain(clip) !== undefined && staticGain(clip) !== 0 ? audioLevels(staticGain(clip)!) : undefined,
        audio ? el("sourcetrack", [el("mediatype", "audio"), el("trackindex", 1)]) : undefined,
        ...links.map((link) =>
          el("link", [el("linkclipref", link.id), el("mediatype", link.mediaType), el("trackindex", link.trackIndex), el("clipindex", link.clipIndex)]),
        ),
      ],
      { id: item.id },
    );
  };

  const trackNode = (built: BuiltTrack): Node => {
    const kids: Node[] = [];
    for (const item of built.items) {
      if (item.dissolveHalf !== undefined) kids.push(transition(item, item.dissolveHalf, built.mediaType));
      kids.push(clipitem(item));
    }
    kids.push(el("enabled", bool(built.enabled)), el("locked", "FALSE"));
    return el("track", kids);
  };

  const markers = [...(timeline.markers ?? [])].sort((a, b) => a.at - b.at);
  if (markers.some((marker) => marker.color !== undefined)) warnings.push("marker colours not exported.");
  const duration = Math.max(0, ...[...videos, ...audios].flatMap((built) => built.items.map((item) => item.place.endFrames)));

  const sequence = el(
    "sequence",
    [
      el("name", options.name ?? timeline.id),
      el("duration", duration),
      rateNode(fps),
      el("media", [
        el("video", [
          el("format", [
            el("samplecharacteristics", [
              rateNode(fps),
              el("width", options.size.width),
              el("height", options.size.height),
              el("anamorphic", "FALSE"),
              el("pixelaspectratio", "square"),
              el("fielddominance", "none"),
            ]),
          ]),
          ...videos.map(trackNode),
        ]),
        el("audio", [
          el("numOutputChannels", 2),
          el("format", [el("samplecharacteristics", [el("depth", SEQUENCE_DEPTH), el("samplerate", SEQUENCE_SAMPLE_RATE)])]),
          ...audios.map(trackNode),
        ]),
      ]),
      timecodeNode(fps),
      ...markers.map((marker) => el("marker", [el("comment", ""), el("name", marker.label), el("in", Math.round(marker.at * fps)), el("out", -1)])),
    ],
    { id: "sequence-1" },
  );

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>"];
  print(el("xmeml", [sequence], { version: String(XMEML_VERSION) }), 0, lines);
  return {
    xml: `${lines.join("\n")}\n`,
    warnings: [...warnings, ...dropped.warnings()],
    tracks: videos.length + audios.length,
    clips: clipCount,
    markers: markers.length,
  };
}

/** `in` and `out` of a media clip in source frames: `out` is `in` plus the source the timeline length consumes at its speed. */
function sourceFrames(clip: AssetClip, place: Placement, fps: number): { in: number; out: number } {
  const start = Math.round(clip.in * fps);
  return { in: start, out: start + Math.round(place.lengthFrames * (clip.speed ?? 1)) };
}

/** `audio.gain` of a clip, dB; undefined when unset or when gain keys replace it (the keys are named as not exported). */
function staticGain(clip: AssetClip): number | undefined {
  return clip.keys?.gain === undefined ? clip.audio?.gain : undefined;
}

/** Most an Audio Levels `level` holds: 3.98109 linear, +12 dB. */
const MAX_GAIN_DB = 12;

/**
 * The Audio Levels filter of `audio.gain` (dB), `level` linear as Premiere writes it (10^(dB/20), `1` = unchanged), at
 * most +12 dB. Unverified against a real Premiere import (ADR 0047).
 */
function audioLevels(gainDb: number): Node {
  const level = 10 ** (Math.min(gainDb, MAX_GAIN_DB) / 20);
  return el("filter", [
    el("effect", [
      el("name", "Audio Levels"),
      el("effectid", "audiolevels"),
      el("effectcategory", "audiolevels"),
      el("effecttype", "audiolevels"),
      el("mediatype", "audio"),
      el("parameter", [el("parameterid", "level"), el("name", "Level"), el("valuemin", 0), el("valuemax", 3.98109), el("value", Number(level.toFixed(6)))]),
    ]),
  ]);
}

function timecodeNode(fps: number): Node {
  return el("timecode", [rateNode(fps), el("string", "00:00:00:00"), el("frame", 0), el("displayformat", "NDF")]);
}

/** The Time Remap filter xmeml uses for a constant `speed`, as a percentage. */
function timeRemap(speed: number, mediaType: "video" | "audio"): Node {
  return el("filter", [
    el("effect", [
      el("name", "Time Remap"),
      el("effectid", "timeremap"),
      el("effectcategory", "motion"),
      el("effecttype", "motion"),
      el("mediatype", mediaType),
      el("parameter", [el("parameterid", "variablespeed"), el("value", 0)], { authoringApp: "PremierePro" }),
      el("parameter", [el("parameterid", "speed"), el("name", "speed"), el("valuemin", -100000), el("valuemax", 100000), el("value", Number((speed * 100).toFixed(4)))]),
      el("parameter", [el("parameterid", "reverse"), el("value", "FALSE")]),
      el("parameter", [el("parameterid", "frameblending"), el("value", "FALSE")]),
    ]),
  ]);
}

/** A dissolve centred on the cut where `item` starts: `half` frames each side. */
function transition(item: Item, half: number, mediaType: "video" | "audio"): Node {
  const cut = item.place.startFrames;
  const sound = mediaType === "audio";
  return el("transitionitem", [
    el("start", cut - half),
    el("end", cut + half),
    el("alignment", "center"),
    el("effect", [
      el("name", sound ? "Cross Fade (+3dB)" : "Cross Dissolve"),
      el("effectid", sound ? "KGAudioTransCrossFade3dB" : "Cross Dissolve"),
      el("effectcategory", "Dissolve"),
      el("effecttype", "transition"),
      el("mediatype", mediaType),
    ]),
  ]);
}

/** Where `pathurl`s are taken from; see {@link premiereAssetUrl}. */
export interface PremiereUrlBase {
  /** Absolute project root. */
  root: string;
  /** Path rules of the machine that owns `root`. Default: this machine's. */
  flavour?: "posix" | "win32";
}

/**
 * `pathurl` of project asset `asset` (ADR 0047 decision 4): always absolute and always in Premiere's own spelling,
 * `file://localhost/` and a percent-encoded path, a Windows drive as `C%3a`. There is no relative mode: the file is not
 * portable, and it is written for the machine that opens it.
 */
export function premiereAssetUrl(base: PremiereUrlBase, asset: string): string {
  const path = base.flavour === "win32" ? win32 : base.flavour === "posix" ? posix : process.platform === "win32" ? win32 : posix;
  const file = path.join(base.root, ...asset.split("/"));
  const slashed = file.split(path.sep).join("/");
  const encoded = encodePath(slashed.startsWith("/") ? slashed : `/${slashed}`);
  return `file://localhost${encoded.replace(/^\/([A-Za-z]):/, "/$1%3a")}`;
}
