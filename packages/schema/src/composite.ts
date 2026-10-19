// How video layers composite (SPEC §3.4, §3.5, §5.3). Pure and shared: the export compiler and the preview place
// layers with these same functions, so a preview frame matches the exported one.
import type {
  AngleCrop,
  Clip,
  ClipAudio,
  ClipTrack,
  MediaClip,
  MulticamGroup,
  ProgramTrack,
  ShotClip,
  ShotLayout,
  Timeline,
  Track,
  Transform,
} from "./timeline.js";

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
 * A nested program track on a video track T becomes program track `T/p1`,
 * `T/p2`, … above T, showing a copy of its group renamed `<nested clip>/<group>`
 * (appended to `groups`); shots fill the frame, so the nested clip's
 * transform does not apply to them. On an audio track it becomes its angles'
 * sound ({@link programSound}).
 *
 * A clip whose timeline `nested` cannot give, or that would nest a timeline
 * inside itself, stays as it is for the caller to report. The root is
 * assumed to be `timelines/<id>.json`.
 */
export function flattenTimeline(timeline: Timeline, nested: NestedTimelines): Timeline {
  const own = timeline.groups ?? [];
  const flat = flattenTracks(timeline.tracks, own, nested, [`timelines/${timeline.id}.json`]);
  // Every group of the root stays, shown or not; nested ones only when shown.
  const groups = [...own, ...flat.groups.filter((group) => !own.includes(group))];
  return { ...timeline, tracks: flat.tracks, ...(groups.length > 0 ? { groups } : {}) };
}

/** Flattened tracks, and the groups their program tracks show. */
interface Flat {
  tracks: Track[];
  groups: MulticamGroup[];
}

/** `tracks`, whose program tracks show groups of `ownGroups`, flattened. */
function flattenTracks(tracks: readonly Track[], ownGroups: readonly MulticamGroup[], nested: NestedTimelines, stack: readonly string[]): Flat {
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
      const inner = isNestedClip(clip) && !stack.includes(clip.source) ? nested(clip.source) : null;
      if (!isNestedClip(clip) || !inner) {
        own.push(clip);
        continue;
      }
      const flat = flattenTracks(inner.tracks, inner.groups ?? [], nested, [...stack, clip.source]);
      const from = clip.in ?? 0;
      const to = clip.duration !== undefined ? from + clip.duration : durationOf(flat.tracks);
      let videoIndex = 0;
      let audioIndex = 0;
      let ownTaken = false;
      const children = flat.tracks.flatMap((child): Track[] => {
        if (child.kind !== "program" || track.kind !== "audio") return [child];
        const group = flat.groups.find((candidate) => candidate.id === child.group);
        return group ? programSound(child, group) : [];
      });
      for (const child of children) {
        if (child.kind === "subtitles") continue;
        if (child.kind === "program") {
          const group = flat.groups.find((candidate) => candidate.id === child.group);
          if (!group) continue;
          // A copy per nested clip, so the clip's gain and mute can go onto its angles.
          const angles = group.angles.map((angle) => {
            const audio = composeAudio(clip.audio, angle.audio);
            return audio ? { ...angle, audio } : angle;
          });
          const renamed: MulticamGroup = { ...group, id: `${clip.id}/${group.id}`, angles };
          groups.push(renamed);
          const id = `${track.id}/p${++programIndex}`;
          const shots = child.clips.flatMap((shot) => windowShot(shot, from, to, clip) ?? []);
          extra.set(id, { id, kind: "program", ...(child.name ? { name: child.name } : {}), group: renamed.id, clips: shots });
          continue;
        }
        let target: Clip[];
        if (track.kind === "video" && child.kind === "video") {
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
          const placed = window(part, from, to, clip, video);
          if (placed) target.push(placed);
        }
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
 * tracks come from a nested clip on a video track that has a transform, at
 * any depth. Flattening makes their shots fill the frame, not the nested
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
        const own = !isIdentityPlacement(placementOf(clip.transform));
        walk(inner.tracks, `${prefix}${clip.id}/`, moved || own, [...stack, clip.source]);
      }
    }
  };
  walk(timeline.tracks, "", false, [`timelines/${timeline.id}.json`]);
  return found;
}

/** `shot` (nested seconds) cut to `[from, to)` and moved to the nested clip's timeline position; null when nothing of it plays. */
function windowShot(shot: ShotClip, from: number, to: number, host: Extract<Clip, { type: "timeline" }>): ShotClip | null {
  const a = Math.max(shot.start, from);
  const b = Math.min(shot.start + (shot.out - shot.in), to);
  if (b <= a) return null;
  return { ...shot, id: `${host.id}/${shot.id}`, start: host.start + (a - from), in: shot.in + (a - shot.start), out: shot.in + (b - shot.start) };
}

/** Adapter types never match `timeline` (ADAPTER_CLIP_TYPE_PATTERN), so `type` alone narrows. */
function isNestedClip(clip: Clip): clip is Extract<Clip, { type: "timeline" }> {
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

/**
 * `part` (nested seconds) cut to `[from, to)`, moved to the nested clip's
 * timeline position, with its transform and audio composed in; null when
 * nothing of it plays.
 */
function window(part: Clip, from: number, to: number, host: Extract<Clip, { type: "timeline" }>, video: boolean): Clip | null {
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
  if (video && host.transform) {
    placed.transform = composePlacement(placementOf(host.transform), placementOf(part.transform));
  } else if (!video) {
    delete placed.transform;
  }
  const audio = composeAudio(host.audio, part.audio);
  if (audio) placed.audio = audio;
  return placed;
}

function composeAudio(outer: ClipAudio | undefined, inner: ClipAudio | undefined): ClipAudio | undefined {
  if (!outer) return inner;
  const gain = (outer.gain ?? 0) + (inner?.gain ?? 0);
  const muted = outer.muted === true || inner?.muted === true;
  return { ...inner, ...(gain !== 0 || inner?.gain !== undefined ? { gain } : {}), ...(muted ? { muted } : {}) };
}

// Multicam shots (ADR 0016). A shot shows its angles in tiles that cover the frame without gaps; each angle's
// picture (after its own crop) fills its tile and is cut to the tile's aspect, centered. Sound never depends
// on the shot: every angle of the group plays under every shot.

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
}

/**
 * Tiles of a `layout` shot with `count` angles in an `output` frame, in
 * angle order. `solo` covers the frame; `two-up` splits it side by side, or
 * stacked when the frame is taller than wide; `grid` picks the columns whose
 * tiles come closest to `aspect` (width / height of the pictures; default
 * 16:9), the last row centered when not full. Edges round to whole pixels,
 * so tiles meet without gaps.
 */
export function shotTiles(layout: ShotLayout, count: number, output: Size, aspect = 16 / 9): LayerRect[] {
  if (count < 1) return [];
  const { width, height } = output;
  if (layout === "solo") return [{ left: 0, top: 0, width, height }];
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
 * {@link coverCrop}). `sourceSize` gives each asset's picture size. Angles
 * missing from `group` are skipped (the timeline schema refuses them).
 */
export function shotLayers(shot: ShotClip, group: MulticamGroup, output: Size, sourceSize: (asset: string) => Size): ShotLayer[] {
  const angles = shot.angles.flatMap((id) => group.angles.find((angle) => angle.id === id) ?? []);
  const areas = angles.map((angle) => croppedRect(sourceSize(angle.asset), angle.crop));
  const aspect = areas.length > 0 ? areas.reduce((sum, area) => sum + area.width / area.height, 0) / areas.length : 16 / 9;
  const tiles = shotTiles(shot.shot, angles.length, output, aspect);
  return angles.map((angle, index) => {
    const tile = tiles[index]!;
    return { angle: angle.id, asset: angle.asset, tile, crop: coverCrop(areas[index]!, tile) };
  });
}

/**
 * Every angle's sound under `shot`, as media clips (`<shot>/<angle>`) in
 * group order: source time = group time - the angle's offset, with its gain
 * and mute. The part before an asset's time 0 is left out (the clip starts
 * later); the end is not bounded by the asset's length, which only a probe
 * knows. Angles with nothing under the shot are left out.
 */
export function shotSound(shot: ShotClip, group: MulticamGroup): MediaClip[] {
  const clips: MediaClip[] = [];
  for (const angle of group.angles) {
    const from = shot.in - angle.offset;
    const to = shot.out - angle.offset;
    if (to <= 0) continue;
    const skipped = Math.max(0, -from);
    clips.push({
      id: `${shot.id}/${angle.id}`,
      type: "media",
      asset: angle.asset,
      start: shot.start + skipped,
      in: from + skipped,
      out: to,
      ...(angle.audio ? { audio: angle.audio } : {}),
    });
  }
  return clips;
}

/**
 * Sound of a program track showing `group`: one audio track per angle
 * (`<track>/<angle>`, group order) holding that angle's {@link shotSound}
 * under each shot, so a mixer that plays audio tracks plays the program.
 */
export function programSound(track: ProgramTrack, group: MulticamGroup): ClipTrack[] {
  return group.angles.map((angle) => {
    const alone = { ...group, angles: [angle] };
    return { id: `${track.id}/${angle.id}`, kind: "audio", name: angle.name, clips: track.clips.flatMap((shot) => shotSound(shot, alone)) };
  });
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
