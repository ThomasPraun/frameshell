// How video layers composite (SPEC §3.4, §3.5, §5.3). Pure and shared: the export compiler and the preview place
// layers with these same functions, so a preview frame matches the exported one.
import type {
  Angle,
  AngleCrop,
  Clip,
  ClipAudio,
  ClipKey,
  ClipKeys,
  ClipTrack,
  KeyEase,
  MediaClip,
  MulticamGroup,
  ProgramTrack,
  ReframeKey,
  ShotClip,
  ShotCorner,
  ShotLayout,
  Timeline,
  Track,
  Transform,
} from "./timeline.js";
import { DEFAULT_SHOT_CORNER } from "./timeline.js";
import { type ClipEdges, type NestHost, type Nesting, type TransitionContext, nestedFades, nestingOf } from "./transitions.js";

/** A clip {@link Transform} with every default filled in. */
export interface Placement {
  /** Offset of the layer's center from the frame's center, project pixels. */
  x: number;
  y: number;
  /** Factor on the fitted size. */
  scale: number;
  /** 0 (invisible) to 1 (opaque). */
  opacity: number;
}

/** Width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Integer pixel rectangle of a layer in an output frame; may reach outside it. */
export interface LayerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** No transform: centered, fitted, opaque. */
export const IDENTITY_PLACEMENT: Placement = Object.freeze({ x: 0, y: 0, scale: 1, opacity: 1 });

/** `transform` with its defaults (SPEC §5.3); absent means {@link IDENTITY_PLACEMENT}. */
export function placementOf(transform: Transform | undefined): Placement {
  return {
    x: transform?.x ?? 0,
    y: transform?.y ?? 0,
    scale: transform?.scale ?? 1,
    opacity: transform?.opacity ?? 1,
  };
}

/** True when `placement` leaves a layer where an untransformed clip would be. */
export function isIdentityPlacement(placement: Placement): boolean {
  return placement.x === 0 && placement.y === 0 && placement.scale === 1 && placement.opacity === 1;
}

/**
 * Where a `source`-sized picture lands in an `output`-sized frame. The
 * picture is first fitted (letterboxed, like an untransformed clip), then
 * scaled about its center, then offset by `x`/`y`, which are project pixels
 * (`project` = `frameshell.json` resolution) mapped onto the output. Sizes
 * round to whole pixels (at least 1), then the corner rounds.
 */
export function layerRect(source: Size, output: Size, project: Size, placement: Placement): LayerRect {
  const fit = Math.min(output.width / source.width, output.height / source.height);
  const width = Math.max(1, Math.round(source.width * fit * placement.scale));
  const height = Math.max(1, Math.round(source.height * fit * placement.scale));
  const cx = output.width / 2 + (placement.x * output.width) / project.width;
  const cy = output.height / 2 + (placement.y * output.height) / project.height;
  return { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height };
}

/**
 * Placement of a clip inside a nested timeline whose clip is placed with
 * `outer`: the nested frame is project-sized, so it fits the outer frame
 * exactly and offsets scale with it. Opacity multiplies per layer (overlapping
 * layers of the nested timeline are not flattened into one group first).
 */
export function composePlacement(outer: Placement, inner: Placement): Placement {
  return {
    x: outer.x + inner.x * outer.scale,
    y: outer.y + inner.y * outer.scale,
    scale: outer.scale * inner.scale,
    opacity: outer.opacity * inner.opacity,
  };
}

/** Parsed timeline of a nested clip's `source`; null when missing or invalid. */
export type NestedTimelines = (source: string) => Timeline | null;

/**
 * SPEC §3.5 step 1: `timeline` with every nested `type: "timeline"` clip
 * replaced by the clips it plays, recursively, so compilers only see media
 * and adapter clips.
 *
 * A nested clip on track T plays nested seconds `[in, in + duration)` from
 * its `start`. The nested timeline's first video track goes onto T itself,
 * in the nested clip's slot; its further video tracks become layers
 * `T/2`, `T/3`, … right above T, and its audio tracks `T/a1`, `T/a2`, …
 * (on an audio track T, every nested track is sound). Clips are cut to the
 * window; ids become `<nested clip>/<clip>`. The nested clip's transform
 * composes with each video clip's ({@link composePlacement}), its gain adds,
 * its mute wins. Subtitle tracks of nested timelines are dropped.
 *
 * Keys and edges (ADR 0018 decision 9): a clip cut by the window loses its
 * own transition fields at the cut. When the nested clip has keys or fades,
 * or the clip has keys, the composition happens at each time instead: the
 * clip keeps its own fields and records the nested clip in its
 * {@link nestingOf} hosts, which {@link placementAt}, {@link gainAt} and
 * {@link hostFades} fold. With `fps` (flattening for playback), the nested
 * clip's `fadeIn` and `fadeOut` become host fades of every clip it plays,
 * its `dissolve` goes onto the clip of T that starts the window (its extra
 * tracks fade in instead, {@link nestedFades}), and clips on a window edge
 * record the nested timeline's seconds outside it as their handle limit.
 *
 * A nested program track on a video track T becomes program track `T/p1`,
 * `T/p2`, … above T, showing a copy of its group renamed `<nested clip>/<group>`
 * (appended to `groups`); shots fill the frame, so the nested clip's
 * transform, keys and fades do not apply to them. Stacking follows the nested track order:
 * when the program track comes before the first video track, that track and
 * the later ones become layers `T/2`, … above `T/p1`. On an audio track it becomes its angles'
 * sound ({@link programSound}), clips marked {@link isProgramSound} so they keep exact samples.
 *
 * A clip whose timeline `nested` cannot give, or that would nest a timeline
 * inside itself, stays as it is for the caller to report. The root is
 * assumed to be `timelines/<id>.json`.
 */
export function flattenTimeline(timeline: Timeline, nested: NestedTimelines, fps?: number): Timeline {
  const own = timeline.groups ?? [];
  const flat = flattenTracks(timeline.tracks, own, nested, [`timelines/${timeline.id}.json`], fps);
  // Every group of the root stays, shown or not; nested ones only when shown.
  const groups = [...own, ...flat.groups.filter((group) => !own.includes(group))];
  return { ...timeline, tracks: flat.tracks, ...(groups.length > 0 ? { groups } : {}) };
}

/** Flattened tracks, and the groups their program tracks show. */
interface Flat {
  tracks: Track[];
  groups: MulticamGroup[];
}

/** A nested timeline clip, resolved. */
type NestedClip = Extract<Clip, { type: "timeline" }>;

/** A clip of a nested timeline cut to its nested clip's window, before the nested clip composes into it. */
interface Windowed {
  placed: Clip;
  part: Clip;
  /** Clips it lands among: the host track's own, or an extra track's. */
  target: Clip[];
  /** On the host track itself (in the nested clip's slot). */
  own: boolean;
  /** Has a picture: a video clip on a video host track. */
  video: boolean;
  /** Starts where the window starts. */
  atStart: boolean;
}

/** `tracks`, whose program tracks show groups of `ownGroups`, flattened. */
function flattenTracks(tracks: readonly Track[], ownGroups: readonly MulticamGroup[], nested: NestedTimelines, stack: readonly string[], fps: number | undefined): Flat {
  const out: Track[] = [];
  const groups: MulticamGroup[] = [];
  for (const track of tracks) {
    if (track.kind === "program") {
      const group = ownGroups.find((candidate) => candidate.id === track.group);
      if (group && !groups.includes(group)) groups.push(group);
    }
    if (track.kind === "subtitles" || track.kind === "program" || !track.clips.some(isNestedClip)) {
      out.push(track);
      continue;
    }
    // Each nested timeline flattened once; its length sizes the nested clips for their fades.
    const inners = new Map<Clip, { flat: Flat; duration: number }>();
    for (const clip of track.clips) {
      if (!isNestedClip(clip) || stack.includes(clip.source)) continue;
      const inner = nested(clip.source);
      if (!inner) continue;
      const flat = flattenTracks(inner.tracks, inner.groups ?? [], nested, [...stack, clip.source], fps);
      inners.set(clip, { flat, duration: durationOf(flat.tracks) });
    }
    const context: TransitionContext | null = fps === undefined ? null : { fps, sourceDuration: (clip) => inners.get(clip)?.duration };
    const own: Clip[] = [];
    /** Extra tracks by id, in first-seen order: layers `T/2`…, program tracks `T/p1`… and sound `T/a1`…. */
    const extra = new Map<string, ClipTrack | ProgramTrack>();
    const extraTrack = (id: string, kind: ClipTrack["kind"]) => {
      let found = extra.get(id);
      if (!found) extra.set(id, (found = { id, kind, clips: [] }));
      return found as ClipTrack;
    };
    // Per host track, not per nested clip: each nested clip has its own renamed group, so its own program track.
    let programIndex = 0;
    for (const clip of track.clips) {
      const resolved = inners.get(clip);
      if (!isNestedClip(clip) || !resolved) {
        own.push(clip);
        continue;
      }
      const { flat, duration } = resolved;
      const from = clip.in ?? 0;
      const to = clip.duration !== undefined ? from + clip.duration : duration;
      let videoIndex = 0;
      let audioIndex = 0;
      let ownTaken = false;
      // A program track listed before the first video track keeps its place under the later ones.
      let programFirst = false;
      const windowed: Windowed[] = [];
      const children = flat.tracks.flatMap((child): Track[] => {
        if (child.kind !== "program" || track.kind !== "audio") return [child];
        const group = flat.groups.find((candidate) => candidate.id === child.group);
        return group ? programSound(child, group).map((sound) => ({ ...sound, clips: sound.clips.map(markProgramSound) })) : [];
      });
      for (const child of children) {
        if (child.kind === "subtitles") continue;
        if (child.kind === "program") {
          const group = flat.groups.find((candidate) => candidate.id === child.group);
          if (!group) continue;
          // A copy per nested clip, so the clip's gain and mute can go onto each sound: the angles playing
          // their own file and the mics (an angle with a mic carries no audio of its own).
          const withClipAudio = <T extends { audio?: ClipAudio | undefined }>(sound: T): T => {
            const audio = composeAudio(clip.audio, sound.audio);
            return audio ? { ...sound, audio } : sound;
          };
          const angles = group.angles.map((angle) => (angle.mic === undefined ? withClipAudio(angle) : angle));
          const mics = group.mics?.map(withClipAudio);
          const renamed: MulticamGroup = { ...group, id: `${clip.id}/${group.id}`, angles, ...(mics ? { mics } : {}) };
          groups.push(renamed);
          if (videoIndex === 0) programFirst = true;
          const id = `${track.id}/p${++programIndex}`;
          const shots = child.clips.flatMap((shot) => windowShot(shot, from, to, clip) ?? []);
          extra.set(id, { id, kind: "program", ...(child.name ? { name: child.name } : {}), group: renamed.id, clips: shots });
          continue;
        }
        let target: Clip[];
        if (track.kind === "video" && child.kind === "video") {
          if (videoIndex === 0 && programFirst) videoIndex = 1;
          videoIndex++;
          target = videoIndex === 1 ? own : extraTrack(`${track.id}/${videoIndex}`, "video").clips;
        } else if (track.kind === "audio" && !ownTaken) {
          // On an audio track the first nested track's sound takes the nested clip's slot.
          ownTaken = true;
          target = own;
        } else {
          target = extraTrack(`${track.id}/a${++audioIndex}`, "audio").clips;
        }
        const video = child.kind === "video" && track.kind === "video";
        for (const part of child.clips) {
          const cut = window(part, { from, to, duration, host: clip, playback: context !== null });
          if (cut) windowed.push({ ...cut, target, own: target === own, video });
        }
      }
      const fades = context && (clip.dissolve !== undefined || clip.fadeIn !== undefined || clip.fadeOut !== undefined) ? nestedFades(clip, track.clips, context) : null;
      // The dissolve plays on the host track when a clip starts the window there; else every track fades in.
      const opener = fades && clip.dissolve !== undefined ? windowed.find((w) => w.own && w.atStart) : undefined;
      for (const w of windowed) {
        const fadeIn = fades ? Math.max(fades.fadeIn, opener && w.own ? 0 : fades.dissolveIn) : 0;
        composeHost(w, clip, from, to, fadeIn, fades?.fadeOut ?? 0);
        if (w === opener) w.placed.dissolve = clip.dissolve!;
        w.target.push(w.placed);
      }
    }
    const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;
    out.push({ ...track, clips: own.sort(byStart) });
    for (const added of extra.values()) {
      (added.clips as { start: number }[]).sort(byStart);
      out.push(added);
    }
  }
  return { tracks: out, groups };
}

/**
 * Ids (as {@link flattenTimeline} renames them) of the groups whose program
 * tracks come from a nested clip on a video track that has a transform or
 * picture keys, at any depth. Flattening makes their shots fill the frame, not the nested
 * clip's place in it, so a caller that draws them must refuse them instead.
 */
export function movedProgramGroups(timeline: Timeline, nested: NestedTimelines): Set<string> {
  const found = new Set<string>();
  const walk = (tracks: readonly Track[], prefix: string, moved: boolean, stack: readonly string[]) => {
    for (const track of tracks) {
      if (track.kind === "program") {
        if (moved) found.add(`${prefix}${track.group}`);
        continue;
      }
      // On an audio track a nested program track is sound only: nothing to place.
      if (track.kind !== "video") continue;
      for (const clip of track.clips) {
        if (!isNestedClip(clip) || stack.includes(clip.source)) continue;
        const inner = nested(clip.source);
        if (!inner) continue;
        walk(inner.tracks, `${prefix}${clip.id}/`, moved || movesPicture(clip), [...stack, clip.source]);
      }
    }
  };
  walk(timeline.tracks, "", false, [`timelines/${timeline.id}.json`]);
  return found;
}

/** True when `clip` moves or fades its picture away from an untransformed one: a transform, or `x`, `y`, `scale` or `opacity` keys. */
export function movesPicture(clip: Clip): boolean {
  return !isIdentityPlacement(placementOf(clip.transform)) || PICTURE_PROPS.some((prop) => clip.keys?.[prop] !== undefined);
}

/** `shot` (nested seconds) cut to `[from, to)` and moved to the nested clip's timeline position; null when nothing of it plays. */
function windowShot(shot: ShotClip, from: number, to: number, host: NestedClip): ShotClip | null {
  const a = Math.max(shot.start, from);
  const b = Math.min(shot.start + (shot.out - shot.in), to);
  if (b <= a) return null;
  return { ...shot, id: `${host.id}/${shot.id}`, start: host.start + (a - from), in: shot.in + (a - shot.start), out: shot.in + (b - shot.start) };
}

/** Adapter types never match `timeline` (ADAPTER_CLIP_TYPE_PATTERN), so `type` alone narrows. */
function isNestedClip(clip: Clip): clip is NestedClip {
  return clip.type === "timeline";
}

/** End of `clip` in its timeline's seconds; null for a nested clip (unresolved) without `duration`. */
function clipEnd(clip: Clip): number | null {
  if ("asset" in clip) return clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
  return clip.duration !== undefined ? clip.start + clip.duration : null;
}

/** Latest clip end over flattened tracks; unresolved nested clips without a length count as ending where they start. */
function durationOf(tracks: readonly Track[]): number {
  let end = 0;
  for (const track of tracks) {
    if (track.kind === "subtitles") continue;
    if (track.kind === "program") for (const shot of track.clips) end = Math.max(end, shot.start + (shot.out - shot.in));
    else for (const clip of track.clips) end = Math.max(end, clipEnd(clip) ?? clip.start);
  }
  return end;
}

/** The window of nested clip `host`: nested seconds `[from, to)` of a nested timeline `duration` seconds long. */
interface Window {
  from: number;
  to: number;
  duration: number;
  host: NestedClip;
  /** Flattening for playback: record the nested timeline's seconds outside the window as handles. */
  playback: boolean;
}

/**
 * `part` (nested seconds) cut to the window and moved to the nested clip's
 * timeline position; null when nothing of it plays. A cut edge drops the
 * part's transition fields there, and its dissolve when it starts the window
 * (the clip it dissolves from is outside). Hosts it already records move with it.
 */
function window(part: Clip, { from, to, duration, host, playback }: Window): Pick<Windowed, "placed" | "part" | "atStart"> | null {
  const end = clipEnd(part) ?? part.start;
  const a = Math.max(part.start, from);
  const b = Math.min(end, to);
  if (b <= a) return null;
  const start = host.start + (a - from);
  const id = `${host.id}/${part.id}`;
  let placed: Clip;
  if ("asset" in part) {
    const speed = part.speed ?? 1;
    placed = { ...part, id, start, in: part.in + (a - part.start) * speed, out: part.in + (b - part.start) * speed };
  } else if (part.duration !== undefined) {
    placed = { ...part, id, start, in: (part.in ?? 0) + (a - part.start), duration: b - a } as Clip;
  } else {
    // Unresolved nested clip of unknown length: keep it, moved; the caller reports it.
    placed = { ...part, id, start } as Clip;
  }
  const atStart = part.start <= from;
  if (atStart) delete placed.dissolve;
  if (part.start < from) delete placed.fadeIn;
  if (end > to) delete placed.fadeOut;
  const nesting = nestingOf(part);
  const shift = host.start - from;
  const hosts = (nesting?.hosts ?? []).map((inner) => ({ ...inner, id: `${host.id}/${inner.id}`, start: inner.start + shift, end: inner.end + shift }));
  const before = playback && atStart ? Math.min(nesting?.before ?? Number.POSITIVE_INFINITY, from) : nesting?.before;
  const after = playback && end >= to ? Math.min(nesting?.after ?? Number.POSITIVE_INFINITY, Math.max(0, duration - to)) : nesting?.after;
  delete (placed as { nesting?: Nesting }).nesting;
  if (hosts.length > 0 || before !== undefined || after !== undefined) {
    const recorded: Nesting = { hosts, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
    Object.assign(placed, { nesting: recorded });
  }
  return { placed, part, atStart };
}

/**
 * Nested clip `host` (window nested seconds `[from, to)`, effective fades
 * `fadeIn`, `fadeOut`) composed into `w`'s clip: baked into its transform and
 * audio when neither changes over time, else recorded as its outermost host.
 */
function composeHost({ placed, part, video }: Windowed, host: NestedClip, from: number, to: number, fadeIn: number, fadeOut: number): void {
  const keys = hostKeys(host.keys, video);
  const animated = hasKeys(part.keys) || (nestingOf(placed)?.hosts.length ?? 0) > 0;
  const gain = host.audio?.gain ?? 0;
  const moves = (video && !isIdentityPlacement(placementOf(host.transform))) || gain !== 0;
  if (keys === undefined && fadeIn === 0 && fadeOut === 0 && !(animated && moves)) {
    if (video && host.transform) {
      placed.transform = composePlacement(placementOf(host.transform), placementOf(part.transform));
    } else if (!video) {
      delete placed.transform;
    }
    const audio = composeAudio(host.audio, part.audio);
    if (audio) placed.audio = audio;
    return;
  }
  if (!video) delete placed.transform;
  if (host.audio?.muted === true) placed.audio = { ...placed.audio, muted: true };
  const entry: NestHost = {
    id: host.id,
    start: host.start,
    end: host.start + (to - from),
    in: from,
    ...(video && host.transform ? { transform: host.transform } : {}),
    ...(keys ? { keys } : {}),
    ...(gain !== 0 ? { gain } : {}),
    ...(fadeIn > 0 ? { fadeIn } : {}),
    ...(fadeOut > 0 ? { fadeOut } : {}),
  };
  const nesting = nestingOf(placed);
  Object.assign(placed, { nesting: { ...nesting, hosts: [entry, ...(nesting?.hosts ?? [])] } satisfies Nesting });
}

/** Properties of a picture's placement that keys can animate. */
const PICTURE_PROPS = ["x", "y", "scale", "opacity"] as const;

/** The keys of a nested clip that reach one of its clips: all of them on a picture, else only `gain`; undefined when none do. */
function hostKeys(keys: ClipKeys | undefined, video: boolean): ClipKeys | undefined {
  if (!keys) return undefined;
  const reaching = video ? keys : keys.gain ? { gain: keys.gain } : {};
  return hasKeys(reaching) ? reaching : undefined;
}

function hasKeys(keys: ClipKeys | undefined): boolean {
  return keys !== undefined && Object.values(keys).some((list) => list !== undefined && list.length > 0);
}

function composeAudio(outer: ClipAudio | undefined, inner: ClipAudio | undefined): ClipAudio | undefined {
  if (!outer) return inner;
  const gain = (outer.gain ?? 0) + (inner?.gain ?? 0);
  const muted = outer.muted === true || inner?.muted === true;
  return { ...inner, ...(gain !== 0 || inner?.gain !== undefined ? { gain } : {}), ...(muted ? { muted } : {}) };
}

// Multicam shots (ADR 0016). A shot shows its angles in tiles that cover the frame without gaps; each angle's
// picture (after its own crop) fills its tile and is cut to the tile's aspect, centered on its reframe point
// (centered without one). Sound never depends on the shot: every angle of the group plays under every shot.

/** One angle's picture in a shot: which source pixels land in which output rectangle. */
export interface ShotLayer {
  /** Angle id. */
  angle: string;
  /** Project-relative asset of the angle. */
  asset: string;
  /** Output rectangle, integer pixels inside the frame. */
  tile: LayerRect;
  /** Source rectangle scaled into `tile`, integer pixels inside the source frame. */
  crop: LayerRect;
  /** True: the tile does not cover the frame (a contained screen), so black must fill the rest of the frame behind it. */
  backdrop: boolean;
  /** Set when the angle's `reframe` moves `crop` during the shot; `crop` is then its place at the time asked. */
  reframe?: CropPath;
}

/**
 * A reframed angle's cut over group time ({@link cropAt}): a crop of fixed
 * size centered on its keys' point, moving in a straight line between keys,
 * its edges rounded to whole pixels and kept inside the cropped picture.
 */
export interface CropPath {
  /** The angle's `reframe` keys with `x`, `y` in source pixels. */
  keys: ReframeKey[];
  width: number;
  height: number;
  /** Range of the crop's left edge, source pixels: the cut stays in the cropped picture. */
  left: readonly [number, number];
  /** Range of the crop's top edge, source pixels. */
  top: readonly [number, number];
}

/** Group second `shot` shows at timeline second `seconds`. */
export function shotGroupTime(shot: ShotClip, seconds: number): number {
  return shot.in + (seconds - shot.start);
}

/**
 * Point the `keys` center on at group second `at` (in the keys' own units):
 * the first key's before it, the last key's after it, a straight line
 * between; null without keys.
 */
export function reframeAt(keys: readonly ReframeKey[] | undefined, at: number): { x: number; y: number } | null {
  if (!keys || keys.length === 0) return null;
  const first = keys[0]!;
  if (at <= first.at) return { x: first.x, y: first.y };
  for (let k = 1; k < keys.length; k++) {
    const b = keys[k]!;
    if (at >= b.at) continue;
    const a = keys[k - 1]!;
    const f = (at - a.at) / (b.at - a.at);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
  const last = keys.at(-1)!;
  return { x: last.x, y: last.y };
}

/**
 * Point of `angle`'s picture (fractions of the source frame) a cut tile
 * centers on at group second `at`: its `reframe` keys', else the center of
 * what its `crop` leaves.
 */
export function reframePointAt(angle: Pick<Angle, "crop" | "reframe">, at: number): { x: number; y: number } {
  const keyed = reframeAt(angle.reframe, at);
  if (keyed) return keyed;
  const { left = 0, top = 0, right = 0, bottom = 0 } = angle.crop ?? {};
  return { x: left + (1 - left - right) / 2, y: top + (1 - top - bottom) / 2 };
}

/** Where `path` cuts at group second `at`. The export compiler writes this formula as an ffmpeg expression (`movingCrop` in core `export/compiler.ts`). */
export function cropAt(path: CropPath, at: number): LayerRect {
  const point = reframeAt(path.keys, at)!;
  const edge = (center: number, size: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(center - size / 2)));
  return { left: edge(point.x, path.width, path.left), top: edge(point.y, path.height, path.top), width: path.width, height: path.height };
}

/**
 * The cover crop of `angle` in `tile` ({@link coverCrop}), moved by its
 * `reframe` to where it is at group second `at`; with the path when the cut
 * moves during `[from, to]`.
 */
function reframedCrop(angle: Angle, area: LayerRect, tile: Size, source: Size, at: number, from: number, to: number): { crop: LayerRect; reframe?: CropPath } {
  const centered = coverCrop(area, tile);
  if (!angle.reframe) return { crop: centered };
  const path: CropPath = {
    keys: angle.reframe.map((key) => ({ at: key.at, x: key.x * source.width, y: key.y * source.height })),
    width: centered.width,
    height: centered.height,
    left: [area.left, area.left + area.width - centered.width],
    top: [area.top, area.top + area.height - centered.height],
  };
  const crop = cropAt(path, at);
  // Straight lines between keys: the cut moves during the shot when it differs at an end or at a key inside.
  const start = cropAt(path, from);
  const times = [to, ...path.keys.map((key) => key.at).filter((time) => time > from && time < to)];
  const moves = times.some((time) => {
    const there = cropAt(path, time);
    return there.left !== start.left || there.top !== start.top;
  });
  return moves ? { crop, reframe: path } : { crop };
}

/** Width of a `pip` inset as a fraction of the frame width, and the most of the frame height it may take. */
const PIP_WIDTH = 0.25;
const PIP_MAX_HEIGHT = 0.4;
/** Gap between a `pip` inset and the frame edges, as a fraction of the frame width. */
const PIP_MARGIN = 0.02;

/** Rectangle of a `pip` inset whose picture has `aspect` (width / height), in the `corner` of an `output` frame. */
function pipInset(output: Size, aspect: number, corner: ShotCorner): LayerRect {
  let width = Math.round(output.width * PIP_WIDTH);
  let height = Math.max(1, Math.round(width / aspect));
  if (height > output.height * PIP_MAX_HEIGHT) {
    height = Math.max(1, Math.round(output.height * PIP_MAX_HEIGHT));
    width = Math.max(1, Math.round(height * aspect));
  }
  const margin = Math.round(output.width * PIP_MARGIN);
  const left = corner.endsWith("left") ? margin : output.width - width - margin;
  const top = corner.startsWith("top") ? margin : output.height - height - margin;
  return { left: Math.max(0, left), top: Math.max(0, top), width, height };
}

/** Largest centered rectangle of `area`'s aspect inside `output`: the whole picture, with bars where the aspects differ. */
function containTile(area: Size, output: Size): LayerRect {
  const scale = Math.min(output.width / area.width, output.height / area.height);
  const width = Math.min(output.width, Math.max(1, Math.round(area.width * scale)));
  const height = Math.min(output.height, Math.max(1, Math.round(area.height * scale)));
  return { left: Math.floor((output.width - width) / 2), top: Math.floor((output.height - height) / 2), width, height };
}

/**
 * Tiles of a `layout` shot with `count` angles in an `output` frame, in
 * angle order. `solo` and `screen` cover the frame; `two-up` splits it side
 * by side, or stacked when the frame is taller than wide; `grid` picks the
 * columns whose tiles come closest to `aspect` (width / height of the
 * pictures; default 16:9), the last row centered when not full; `pip` is the
 * whole frame, then an inset of picture aspect `aspect` in `corner` (default
 * bottom-right). Edges round to whole pixels, so grid tiles meet without gaps.
 */
export function shotTiles(layout: ShotLayout, count: number, output: Size, aspect = 16 / 9, corner: ShotCorner = DEFAULT_SHOT_CORNER): LayerRect[] {
  if (count < 1) return [];
  const { width, height } = output;
  if (layout === "solo" || layout === "screen") return [{ left: 0, top: 0, width, height }];
  if (layout === "pip") {
    const whole = { left: 0, top: 0, width, height };
    return count === 1 ? [whole] : [whole, pipInset(output, aspect, corner)];
  }
  let cols: number;
  if (layout === "two-up") cols = width >= height ? 2 : 1;
  else cols = gridColumns(count, output, aspect);
  const shown = layout === "two-up" ? 2 : count;
  const rows = Math.ceil(shown / cols);
  const tiles: LayerRect[] = [];
  for (let index = 0; index < shown; index++) {
    const row = Math.floor(index / cols);
    const inRow = Math.min(cols, shown - row * cols);
    const offset = ((cols - inRow) * width) / cols / 2;
    const column = index - row * cols;
    const left = Math.round(offset + (column * width) / cols);
    const right = Math.round(offset + ((column + 1) * width) / cols);
    const top = Math.round((row * height) / rows);
    const bottom = Math.round(((row + 1) * height) / rows);
    tiles.push({ left, top, width: right - left, height: bottom - top });
  }
  return tiles;
}

/** Columns of a `count`-tile grid: tile aspect nearest `aspect`; ties to fewer empty cells, then fewer columns. */
function gridColumns(count: number, output: Size, aspect: number): number {
  let best = { cols: 1, score: Number.POSITIVE_INFINITY, empty: Number.POSITIVE_INFINITY };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const score = Math.abs(Math.log(output.width / cols / (output.height / rows) / aspect));
    const empty = cols * rows - count;
    if (score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && empty < best.empty)) best = { cols, score, empty };
  }
  return best.cols;
}

/** Source pixels left by an angle's `crop`, before any layout. */
export function croppedRect(source: Size, crop: AngleCrop | undefined): LayerRect {
  const left = Math.round((crop?.left ?? 0) * source.width);
  const top = Math.round((crop?.top ?? 0) * source.height);
  const right = Math.round((crop?.right ?? 0) * source.width);
  const bottom = Math.round((crop?.bottom ?? 0) * source.height);
  return { left, top, width: Math.max(1, source.width - left - right), height: Math.max(1, source.height - top - bottom) };
}

/** Centered part of `area` (source pixels) with the aspect of `tile`, so it fills the tile without bars. */
export function coverCrop(area: LayerRect, tile: Size): LayerRect {
  const scale = Math.max(tile.width / area.width, tile.height / area.height);
  const width = Math.max(1, Math.min(area.width, Math.round(tile.width / scale)));
  const height = Math.max(1, Math.min(area.height, Math.round(tile.height / scale)));
  return {
    left: area.left + Math.floor((area.width - width) / 2),
    top: area.top + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Layers of `shot` in an `output` frame: one per angle it shows, in its
 * order, each angle's cropped picture filling its tile ({@link shotTiles},
 * {@link coverCrop}); later layers paint over earlier ones. A `screen` shot,
 * and the first angle of a `pip` shot, show the whole cropped picture,
 * centered with black bars where the aspects differ: a screen is never cut.
 * The bars are black, not what lies below: such a layer has `backdrop` set and
 * the compositor paints black over the whole frame behind it.
 * A `pip` inset keeps its picture's aspect. A cut picture centers on its
 * angle's `reframe` point at group second `at` (default: the shot's `in`).
 * `sourceSize` gives each asset's picture size. Angles missing from `group`
 * are skipped (the timeline schema refuses them).
 */
export function shotLayers(shot: ShotClip, group: MulticamGroup, output: Size, sourceSize: (asset: string) => Size, at = shot.in): ShotLayer[] {
  const angles = shot.angles.flatMap((id) => group.angles.find((angle) => angle.id === id) ?? []);
  const sizes = angles.map((angle) => sourceSize(angle.asset));
  const areas = angles.map((angle, index) => croppedRect(sizes[index]!, angle.crop));
  const cut = (index: number, tile: Size) => reframedCrop(angles[index]!, areas[index]!, tile, sizes[index]!, at, shot.in, shot.out);
  if (shot.shot === "screen" || shot.shot === "pip") {
    const insetArea = areas[1];
    const tiles = shotTiles(shot.shot, angles.length, output, insetArea ? insetArea.width / insetArea.height : 16 / 9, shot.corner);
    return angles.map((angle, index) => {
      const area = areas[index]!;
      const tile = index === 0 ? containTile(area, output) : tiles[index]!;
      const backdrop = index === 0 && (tile.width < output.width || tile.height < output.height);
      if (index === 0) return { angle: angle.id, asset: angle.asset, tile, crop: area, backdrop };
      return { angle: angle.id, asset: angle.asset, tile, ...cut(index, tile), backdrop };
    });
  }
  const aspect = areas.length > 0 ? areas.reduce((sum, area) => sum + area.width / area.height, 0) / areas.length : 16 / 9;
  const tiles = shotTiles(shot.shot, angles.length, output, aspect);
  return angles.map((angle, index) => {
    const tile = tiles[index]!;
    return { angle: angle.id, asset: angle.asset, tile, ...cut(index, tile), backdrop: false };
  });
}

/** One sound of a multicam group: an angle's own file, or a mic. */
export interface GroupSound {
  /** Angle id (its own file's sound) or mic id; unique in the group. */
  id: string;
  /** Display name of the angle or mic. */
  name: string;
  /** Project-relative file. */
  asset: string;
  /** Group-clock second at which the file's time 0 plays. */
  offset: number;
  /** Gain and mute of this sound under every shot. */
  audio?: ClipAudio;
}

/**
 * The sounds that play under every shot of `group`, in order: the own-file
 * sound of each angle without a `mic`, then each mic once however many
 * angles use it. Angles with `mic: null` or a mic add none of their own.
 */
export function groupSounds(group: MulticamGroup): GroupSound[] {
  const own = group.angles.filter((angle) => angle.mic === undefined);
  return [...own, ...(group.mics ?? [])].map(({ id, name, asset, offset, audio }) => ({ id, name, asset, offset, ...(audio ? { audio } : {}) }));
}

/** `sound` under `shot` as a media clip (`<shot>/<sound id>`); null when nothing of it plays there. */
function soundClip(shot: ShotClip, sound: GroupSound): MediaClip | null {
  const from = shot.in - sound.offset;
  const to = shot.out - sound.offset;
  if (to <= 0) return null;
  const skipped = Math.max(0, -from);
  return {
    id: `${shot.id}/${sound.id}`,
    type: "media",
    asset: sound.asset,
    start: shot.start + skipped,
    in: from + skipped,
    out: to,
    ...(sound.audio ? { audio: sound.audio } : {}),
  };
}

/**
 * Every sound of the group ({@link groupSounds}) under `shot`, as media clips
 * (`<shot>/<sound id>`): source time = group time - the sound's offset, with
 * its gain and mute. The part before an asset's time 0 is left out (the clip
 * starts later); the end is not bounded by the asset's length, which only a
 * probe knows. Sounds with nothing under the shot are left out.
 */
export function shotSound(shot: ShotClip, group: MulticamGroup): MediaClip[] {
  return groupSounds(group).flatMap((sound) => soundClip(shot, sound) ?? []);
}

/** Where a {@link shotSound} clip plays, in samples. */
export interface SoundSamples {
  /** First program sample, at the program rate. */
  start: number;
  /** Program sample after the last. */
  end: number;
  /** First source sample, at the source's own rate. */
  in: number;
}

/**
 * `clip` (from {@link shotSound}) in exact samples: its seconds rounded once
 * to `rate`, never through frames, so sounds of one room stay aligned however
 * they sit against the frame grid. Preview and export both place sound here.
 */
export function soundSamples(clip: MediaClip, rate: number, sourceRate = rate): SoundSamples {
  return {
    start: Math.round(clip.start * rate),
    end: Math.round((clip.start + clip.out - clip.in) * rate),
    in: Math.round(clip.in * sourceRate),
  };
}

/**
 * Sound of a program track showing `group`: one audio track per sound
 * (`<track>/<sound id>`, {@link groupSounds} order) holding its
 * {@link shotSound} under each shot, so a mixer that plays audio tracks
 * plays the program. Where hand-edited shots overlap, the later shot wins
 * from its start, as in the picture: the earlier shot's sound ends there.
 */
export function programSound(track: ProgramTrack, group: MulticamGroup): ClipTrack[] {
  const shots = [...track.clips].sort((a, b) => a.start - b.start);
  const heard = shots.map((shot, i) => {
    const next = shots[i + 1];
    if (!next || shot.start + shot.out - shot.in <= next.start) return shot;
    return { ...shot, out: shot.in + Math.max(0, next.start - shot.start) };
  });
  return groupSounds(group).map((sound) => ({
    id: `${track.id}/${sound.id}`,
    kind: "audio",
    name: sound.name,
    clips: heard.flatMap((shot) => soundClip(shot, sound) ?? []),
  }));
}

/**
 * Mark of a program sound clip that flattening moved onto a plain audio track. A symbol key: spreads keep
 * it, JSON and Zod never see it, so the flattened timeline still parses and nothing writes it.
 */
const PROGRAM_SOUND = Symbol.for("frameshell.programSound");

function markProgramSound<T extends Clip>(clip: T): T {
  return Object.assign({ ...clip }, { [PROGRAM_SOUND]: true });
}

/**
 * True for a clip of a nested program track's sound on an audio host track
 * ({@link flattenTimeline}). Like a program track's own sound, it plays at
 * {@link soundSamples}, not on frames: export and preview both check it.
 * The mark does not survive JSON or `structuredClone`: flatten in the same
 * place that places the sound.
 */
export function isProgramSound(clip: Clip): boolean {
  return (clip as { [PROGRAM_SOUND]?: true })[PROGRAM_SOUND] === true;
}

/** The group `track` shows; null when the timeline has none by that id. */
export function programGroup(timeline: Pick<Timeline, "groups">, track: ProgramTrack): MulticamGroup | null {
  return timeline.groups?.find((group) => group.id === track.group) ?? null;
}

/**
 * `timeline` with each program track replaced, in its place, by its
 * {@link programSound} tracks, for code that only listens (word checks,
 * audio pauses). A program track whose group is missing goes silent.
 */
export function withProgramSound(timeline: Timeline): Timeline {
  if (!timeline.tracks.some((track) => track.kind === "program")) return timeline;
  const tracks = timeline.tracks.flatMap((track): Track[] => {
    if (track.kind !== "program") return [track];
    const group = programGroup(timeline, track);
    return group ? programSound(track, group) : [];
  });
  return { ...timeline, tracks };
}

/** Second of the clip's own clock (what its `in` counts, ADR 0018 decision 6) playing at timeline second `t`. */
export function clipTime(clip: Clip, t: number): number {
  const speed = "asset" in clip ? (clip.speed ?? 1) : 1;
  return (clip.in ?? 0) + (t - clip.start) * speed;
}

/** `f` (0 to 1, the fraction of the way between two keys) through `ease`: `in` f², `out` f(2-f), `in-out` f²(3-2f). */
export function easeFraction(ease: KeyEase | undefined, f: number): number {
  switch (ease) {
    case "in":
      return f * f;
    case "out":
      return f * (2 - f);
    case "in-out":
      return f * f * (3 - 2 * f);
    default:
      return f;
  }
}

/** Value of `keys` at clip-clock second `at`: held before the first and after the last, eased between; null without keys. */
export function keyedValueAt(keys: readonly ClipKey[] | undefined, at: number): number | null {
  if (!keys || keys.length === 0) return null;
  const first = keys[0]!;
  if (at <= first.at) return first.value;
  for (let k = 1; k < keys.length; k++) {
    const b = keys[k]!;
    if (at >= b.at) continue;
    const a = keys[k - 1]!;
    return a.value + (b.value - a.value) * easeFraction(a.ease, (at - a.at) / (b.at - a.at));
  }
  return keys.at(-1)!.value;
}

/** Placement of `clip` at timeline second `t`: a keyed property follows its keys, the others their `transform` value. */
export function placementAt(clip: Clip, t: number): Placement {
  let placement = keyedPlacement(clip.transform, clip.keys, clipTime(clip, t));
  // A flattened clip sits inside its hosts' frames: innermost first ({@link composePlacement}).
  const hosts = nestingOf(clip)?.hosts;
  if (hosts) for (let i = hosts.length - 1; i >= 0; i--) placement = composePlacement(hostPlacementAt(hosts[i]!, t), placement);
  return placement;
}

/**
 * Placement of `clip` that holds while nothing animates it ({@link hasPictureKeys} false): its `transform` inside its
 * hosts' ({@link nestingOf}). With keys, the value at its start.
 */
export function fixedPlacement(clip: Clip): Placement {
  return nestingOf(clip)?.hosts.length ? placementAt(clip, clip.start) : placementOf(clip.transform);
}

/** Placement of nested clip `host` at timeline second `t`, on its own clock. */
function hostPlacementAt(host: NestHost, t: number): Placement {
  return keyedPlacement(host.transform, host.keys, hostTime(host, t));
}

/** `transform` with each keyed property replaced by its keys' value at clock second `at`. */
function keyedPlacement(transform: Transform | undefined, keys: ClipKeys | undefined, at: number): Placement {
  const base = placementOf(transform);
  if (!keys) return base;
  return {
    x: keyedValueAt(keys.x, at) ?? base.x,
    y: keyedValueAt(keys.y, at) ?? base.y,
    scale: keyedValueAt(keys.scale, at) ?? base.scale,
    opacity: keyedValueAt(keys.opacity, at) ?? base.opacity,
  };
}

/** Second of nested clip `host`'s own clock (nested-timeline seconds) playing at timeline second `t`. */
export function hostTime(host: NestHost, t: number): number {
  return host.in + (t - host.start);
}

/**
 * Gain in dB of `clip` at timeline second `t`: its `gain` keys, else `audio.gain`, else 0, plus each host's the same
 * way ({@link nestingOf}). `audio.muted` is for the caller.
 */
export function gainAt(clip: Clip, t: number): number {
  let gain = keyedValueAt(clip.keys?.gain, clipTime(clip, t)) ?? clip.audio?.gain ?? 0;
  for (const host of nestingOf(clip)?.hosts ?? []) gain += keyedValueAt(host.keys?.gain, hostTime(host, t)) ?? host.gain ?? 0;
  return gain;
}

/** Gain in dB of `clip` where no key changes it: its `audio.gain` plus its hosts'. */
export function staticGain(clip: Clip): number {
  let gain = clip.audio?.gain ?? 0;
  for (const host of nestingOf(clip)?.hosts ?? []) gain += host.gain ?? 0;
  return gain;
}

/** A property keys can animate (`ClipKeys`). */
export type KeyedProp = keyof ClipKeys;

/** True when keys animate `prop` of `clip`: its own, or a host's ({@link nestingOf}). */
export function isKeyed(clip: Clip, prop: KeyedProp): boolean {
  return clip.keys?.[prop] !== undefined || (nestingOf(clip)?.hosts.some((host) => host.keys?.[prop] !== undefined) ?? false);
}

/** True when keys animate `clip`'s placement: `x`, `y`, `scale` or `opacity`, its own or a host's. */
export function hasPictureKeys(clip: Clip): boolean {
  return PICTURE_PROPS.some((prop) => isKeyed(clip, prop));
}

/** A fade of a nested clip over its window, timeline seconds; `fadeIn`/`fadeOut` 0 for none. */
export interface HostFade {
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
}

/** Fades of the hosts of `clip` that have any ({@link nestingOf}), outermost first. Multiply each in like the clip's own. */
export function hostFades(clip: Clip): HostFade[] {
  return (nestingOf(clip)?.hosts ?? []).flatMap((host) =>
    host.fadeIn || host.fadeOut ? [{ start: host.start, end: host.end, fadeIn: host.fadeIn ?? 0, fadeOut: host.fadeOut ?? 0 }] : [],
  );
}

const clamp01 = (f: number) => Math.min(1, Math.max(0, f));

/** Quarter sine, `sin(f·π/2)`: the equal-power curve of sound fades and crossfades (ffmpeg `qsin`). `f` clamps to 0..1. */
export function soundCurve(f: number): number {
  return Math.sin((clamp01(f) * Math.PI) / 2);
}

/**
 * How far a dissolve has come at timeline second `t`: 0 to 1 across its `2 * half` seconds centered on the
 * incoming clip's start; 0 before and 1 after.
 */
export function dissolveProgress(clipStart: number, half: number, t: number): number {
  if (half <= 0) return 1;
  return clamp01((t - (clipStart - half)) / (2 * half));
}

/**
 * Factor 0 to 1 of a clip's fades at `t` (`fadeIn` and `fadeOut` of its {@link ClipEdges}): linear for pictures,
 * {@link soundCurve} for sound. Multiply it into the clip's opacity or gain.
 */
export function fadeWeight(edges: Pick<ClipEdges, "fadeIn" | "fadeOut">, clipStart: number, clipEnd: number, t: number, sound = false): number {
  const shape = sound ? soundCurve : clamp01;
  const fadeIn = edges.fadeIn > 0 ? shape((t - clipStart) / edges.fadeIn) : 1;
  const fadeOut = edges.fadeOut > 0 ? shape((clipEnd - t) / edges.fadeOut) : 1;
  return fadeIn * fadeOut;
}

/**
 * Weights of the incoming and outgoing clip of a dissolve at progress `f` (0 to 1). Pictures: the incoming clip
 * rides `f`; the outgoing one rides `1 - f` on an `upper` track and stays opaque on the `bottom` track (the incoming
 * clip is drawn over it, an exact mix). `sound`: both follow {@link soundCurve}, equal power.
 */
export function dissolveWeights(f: number, kind: "bottom" | "upper" | "sound"): { incoming: number; outgoing: number } {
  const w = clamp01(f);
  if (kind === "sound") return { incoming: soundCurve(w), outgoing: soundCurve(1 - w) };
  return { incoming: w, outgoing: kind === "bottom" ? 1 : 1 - w };
}
