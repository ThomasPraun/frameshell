import {
  ErrorCode,
  type OperationName,
  type OperationResult,
  RpcError,
  type SnapReport,
  type TimelinePatch,
  type operationArgs,
} from "@frameshell/protocol";
import { basename } from "node:path/posix";
import {
  type Angle,
  type AnyClip,
  type AnyClipTrack,
  CORE_CLIP_TYPES,
  type Clip,
  type ClipTrack,
  type MediaClip,
  type MulticamGroup,
  type ProgramTrack,
  type ShotClip,
  type TimelineClip,
  type Timeline,
  type Track,
  isShotClip,
  parseTimeline,
  programGroup,
  scriptRefPathProblem,
  shotSound,
  splitScriptRef,
} from "@frameshell/schema";
import type { z } from "zod";
import { DEFAULT_SNAP_WINDOW_S } from "../media/energy.js";
import { FrameGrid } from "./grid.js";
import { applyPatch, diffTimelines, sortClips } from "./patch.js";
import { NestedTimelineError, clipEnd, nestedClipError } from "./timing.js";

/** What the engine needs to know about a media file. */
export interface SourceInfo {
  /** Seconds; null for still images (any length). */
  duration: number | null;
  video: boolean;
  audio: boolean;
}

/** An adapter-registered clip type as the engine sees it. */
export interface ClipTypeInfo {
  /** Null when `props` are valid, else a human-readable reason. */
  validateProps(props: Record<string, unknown>): Promise<string | null>;
}

/**
 * Where a cut or trim edge lands, before frame snapping. Energy snapping
 * (#12, ADR 0003) plugs in here to move edges into audio pauses.
 */
export interface EditPoint {
  /** Seconds on {@link EditPoint.clock}. */
  time: number;
  /** `timeline` for `cut` and trims by `start`/`end`; `source` for trims by `in`/`out`. */
  clock: "timeline" | "source";
  /** `start`: first kept frame after removed material; `end`: removed material follows. */
  edge: "start" | "end";
  /** Search half-width, seconds: op `snapWindow`, else {@link EditContext.snapWindow}, else {@link DEFAULT_SNAP_WINDOW_S}. */
  window: number;
  /** Clip being trimmed; absent for `cut`, which spans tracks. Shots are never snapped (their sound is not theirs). */
  clip?: Clip;
  /** `cut` only: clips of the tracks being cut, as before the operation; a program track's shots as their angles' sound (`shotSound`). */
  clips?: Clip[];
  /** Earliest allowed result, same clock (op `snapBounds`). The engine clamps a result outside. */
  min?: number;
  /** Latest allowed result, same clock (op `snapBounds`). */
  max?: number;
}

/** A `snapBounds` range; both ends optional. */
type SnapRange = { min?: number | undefined; max?: number | undefined };

/** Where a resolver put an edge. */
export interface EditPointResolution {
  /** Adjusted time, same clock as the request. */
  time: number;
  /** True inside an audio pause; false when none was in reach (speech may be clipped). */
  clean: boolean;
}

/** See {@link EditPoint}. Null: not applicable here (no audio under the edge); the edge stays. */
export type EditPointResolver = (point: EditPoint) => EditPointResolution | null | Promise<EditPointResolution | null>;

/**
 * Everything project-specific an operation may consult. Implemented by the
 * daemon's timeline service; tests pass an in-memory one.
 */
export interface EditContext {
  /** Project frame rate. */
  fps: number;
  /**
   * Probe of a project-relative asset. Throws an actionable `RpcError`
   * (AssetNotFound, InvalidOperation) when missing or not media.
   */
  source(asset: string): Promise<SourceInfo>;
  /** Derived duration of a nested timeline file (project-relative). Throws `NestedTimelineError` when missing, invalid or cyclic. */
  nestedDuration(source: string): Promise<number>;
  /** Adapter clip types loaded for the project; empty when plugins are untrusted. */
  clipTypes(): Promise<ReadonlyMap<string, ClipTypeInfo>>;
  /** Fresh id with prefix `c` (clip), `t` (track) or `g` (multicam group); the engine retries on collision. */
  newId(prefix: "c" | "t" | "g"): string;
  /** Edge adjustment seam for `cut` and `clip.trim` (#12). Absent: edges stay. */
  resolveEditPoint?: EditPointResolver;
  /** Project default snap half-width, seconds (`editing.snapWindow`); an op's `snapWindow` overrides it. */
  snapWindow?: number;
}

/** Args of a public operation after param validation. */
export type OperationArgs<K extends OperationName> = z.output<(typeof operationArgs)[K]>;

/** Any operation the engine applies: a public verb, or a patch (inverses, reverts). */
export type OperationRequest =
  | { [K in OperationName]: { op: K; args: OperationArgs<K> } }[OperationName]
  | { op: "timeline.patch"; args: TimelinePatch };

/** Outcome of {@link applyOperation}. */
export interface AppliedOperation {
  /** New timeline, revision bumped by one. */
  timeline: Timeline;
  /** Applied right after, restores the input timeline (with canonical clip order). */
  inverse: { op: "timeline.patch"; args: TimelinePatch };
  changes: OperationResult["changes"];
  /** Edges placed by {@link EditContext.resolveEditPoint}, in arg order. */
  snaps: SnapReport[];
  /** Applied anyway, worth fixing (e.g. `cut` inside a generated clip); merged into the result's `warnings`. */
  warnings: string[];
}

/**
 * Validate and apply one operation to `timeline` (SPEC §6.1): snap times to
 * the frame grid, enforce timeline rules on what changed (no overlaps on a
 * track, clips at least one frame long, in/out inside the source, track kind
 * accepts the clip type), bump `revision`, and return the inverse.
 *
 * Pure apart from `context` lookups: `timeline` is not modified. Clip order
 * is normalized (by start) first. Throws `RpcError` InvalidOperation,
 * TrackNotFound, ClipNotFound or whatever `context` throws; messages say
 * what failed, the valid range and a fix.
 */
export async function applyOperation(
  timeline: Timeline,
  request: OperationRequest,
  context: EditContext,
): Promise<AppliedOperation> {
  const before = structuredClone(timeline);
  for (const track of before.tracks) if (track.kind !== "subtitles") sortClips(track);
  const edit = new Edit(before, request.op, context);
  await edit.run(request);
  return edit.finish();
}

/** One operation in progress over a draft copy. */
class Edit {
  readonly draft: Timeline;
  readonly grid: FrameGrid;
  readonly #spans = new Map<string, Promise<number>>();
  readonly snaps: SnapReport[] = [];
  readonly warnings: string[] = [];
  #pending: Pick<SnapReport, "clean" | "window"> | null = null;

  constructor(
    readonly before: Timeline,
    readonly op: string,
    readonly context: EditContext,
  ) {
    this.draft = structuredClone(before);
    this.grid = new FrameGrid(context.fps);
  }

  async run(request: OperationRequest): Promise<void> {
    switch (request.op) {
      case "track.add":
        return this.trackAdd(request.args);
      case "track.remove":
        return this.trackRemove(request.args);
      case "track.set":
        return this.trackSet(request.args);
      case "clip.add":
        return this.clipAdd(request.args);
      case "clip.move":
        return this.clipMove(request.args);
      case "clip.trim":
        return this.clipTrim(request.args);
      case "clip.split":
        return this.clipSplit(request.args);
      case "clip.remove":
        return this.clipRemove(request.args);
      case "clip.set":
        return this.clipSet(request.args);
      case "cut":
        return this.cut(request.args);
      case "multicam.create":
        return this.multicamCreate(request.args);
      case "multicam.offset":
        return this.multicamOffset(request.args);
      case "timeline.patch":
        return this.patch(request.args);
    }
  }

  // Tracks

  trackAdd(args: OperationArgs<"track.add">): void {
    const { kind, name, follows, index, style } = args;
    if (kind === "subtitles") {
      if (follows === undefined) {
        throw this.invalid("a subtitle track needs `follows`: the video or audio track whose words it shows.", {
          field: "follows",
          hint: `Clip tracks here: ${this.mediaTracks().map((t) => t.id).join(", ") || "none, add one first"}.`,
        });
      }
      this.checkFollows(follows);
    } else {
      this.refuseSubtitleFields(args);
    }
    const count = this.draft.tracks.length;
    if (index !== undefined && index > count) {
      throw this.invalid(`index ${index} is past the top of the stack.`, { field: "index", valid: { min: 0, max: count } });
    }
    const id = this.newId("t");
    const track: Track =
      kind === "subtitles"
        ? { id, kind, ...(name ? { name } : {}), follows: follows!, ...(style && Object.keys(style).length > 0 ? { style } : {}) }
        : { id, kind, ...(name ? { name } : {}), clips: [] };
    this.draft.tracks.splice(index ?? count, 0, track);
  }

  trackSet(args: OperationArgs<"track.set">): void {
    const track = this.track(args.track);
    const { name, follows, style } = args;
    if (name === undefined && follows === undefined && style === undefined) {
      throw this.invalid("nothing to change.", { hint: "Pass `name`, or for subtitle tracks `follows` or `style`." });
    }
    if (track.kind !== "subtitles") this.refuseSubtitleFields(args);
    if (name === null) delete track.name;
    else if (name !== undefined) track.name = name;
    if (track.kind !== "subtitles") return;
    if (follows !== undefined) {
      this.checkFollows(follows);
      track.follows = follows;
    }
    if (style !== undefined) {
      const merged = { ...track.style, ...Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) };
      if (Object.keys(merged).length > 0) track.style = merged;
    }
  }

  /** `follows` must name an existing video or audio track. */
  checkFollows(follows: string): void {
    const { kind } = this.track(follows);
    if (kind === "subtitles" || kind === "program") {
      throw this.invalid(`\`follows\` must name a video or audio track; ${follows} is a ${kind === "program" ? "program" : "subtitle"} track.`, {
        field: "follows",
      });
    }
  }

  refuseSubtitleFields(args: { follows?: string | undefined; style?: object | undefined }): void {
    if (args.follows !== undefined) throw this.invalid("only subtitle tracks take `follows`.", { field: "follows" });
    if (args.style !== undefined) throw this.invalid("only subtitle tracks take `style`.", { field: "style" });
  }

  trackRemove(args: OperationArgs<"track.remove">): void {
    const track = this.track(args.track);
    const followers = this.draft.tracks.filter((t) => t.kind === "subtitles" && t.follows === track.id);
    if (followers.length > 0) {
      const ids = followers.map((t) => t.id).join(", ");
      throw this.invalid(`subtitle track ${ids} follows ${track.id}.`, { hint: `Remove ${ids} first.` });
    }
    if (track.kind !== "subtitles" && track.clips.length > 0 && !args.force) {
      throw this.invalid(`track ${track.id} has ${track.clips.length} clip(s).`, {
        field: "force",
        hint: "Pass `force: true` (CLI `--force`) to remove it with its clips.",
      });
    }
    this.draft.tracks.splice(this.draft.tracks.indexOf(track), 1);
  }

  // Clips

  async clipAdd(args: OperationArgs<"clip.add">): Promise<void> {
    const target = this.clipTrack(args.track);
    if (target.kind === "program") {
      throw this.unsupported(`track ${target.id} is a program track; adding shots with \`clip.add\` is not supported yet.`, {
        feature: "shot.add",
        hint: "Change its shots with `clip.split`, `clip.trim`, `clip.move` or `clip.remove`, or edit the timeline file.",
      });
    }
    const track = target;
    const rippled = this.rippleScope(args, track);
    const { type } = args;
    if (type === "shot") {
      throw this.invalid("shot clips belong on a program track, which holds the shots of a multicam group.", {
        field: "type",
        hint: "Use `media` for a file on a video or audio track.",
      });
    }
    if (track.kind === "audio" && args.transform) throw this.invalid("audio tracks take no `transform`.", { field: "transform" });
    if (args.scriptRef !== undefined) this.checkScriptRefShape(args.scriptRef);
    const extras = {
      ...(args.transform ? { transform: args.transform } : {}),
      ...(args.gain !== undefined || args.muted !== undefined
        ? { audio: { ...(args.gain !== undefined ? { gain: args.gain } : {}), ...(args.muted !== undefined ? { muted: args.muted } : {}) } }
        : {}),
      ...(args.scriptRef ? { scriptRef: args.scriptRef } : {}),
    };
    if (args.snap === true && type !== "media") {
      throw this.invalid(`only media clips take \`snap\`; ${type} clips have no audio to snap to.`, { field: "snap" });
    }
    if (args.snapBounds !== undefined && args.snap !== true) {
      throw this.invalid("`snapBounds` needs `snap: true`.", { field: "snapBounds" });
    }
    const start = args.start === undefined ? await this.trackEnd(track) : this.grid.snap(args.start);
    const id = this.newId("c");
    let clip: Clip;
    if (type === "media") {
      this.refuse(args, ["source", "props"], "media clips");
      if (!args.asset) throw this.invalid("media clips need `asset`, e.g. `assets/raw-01.mp4`.", { field: "asset" });
      const info = await this.context.source(args.asset);
      if (track.kind === "video" && !info.video) {
        throw this.invalid(`${args.asset} has no video stream; it belongs on an audio track.`, { field: "track" });
      }
      if (track.kind === "audio" && !info.audio) {
        throw this.invalid(`${args.asset} has no audio stream; it belongs on a video track.`, { field: "track" });
      }
      const speed = args.speed ?? 1;
      const maxOut = this.maxOut(info);
      const clipIn = this.grid.snap(args.in ?? 0);
      if (clipIn >= maxOut) {
        throw this.invalid(`in ${clipIn} is at or past the end of ${args.asset} (${maxOut} s).`, {
          field: "in",
          valid: { min: 0, max: this.grid.seconds(this.grid.frame(maxOut) - 1) },
        });
      }
      let out: number;
      if (args.out !== undefined) {
        if (args.duration !== undefined) throw this.invalid("pass `out` or `duration`, not both.", { field: "duration" });
        out = this.boundOut(args.out, clipIn, info, args.asset);
      } else if (args.duration !== undefined) {
        out = this.boundOut(clipIn + args.duration * speed, clipIn, info, args.asset);
      } else if (info.duration === null) {
        throw this.invalid(`${args.asset} is a still image with no length.`, { field: "duration", hint: "Pass `duration` in seconds." });
      } else {
        out = maxOut;
      }
      const media: MediaClip = { id, type, asset: args.asset, start, in: clipIn, out, ...(speed !== 1 ? { speed } : {}), ...extras };
      if (args.snap === true) await this.snapNewClip(media, info, args, out);
      clip = media;
    } else if (type === "timeline") {
      this.refuse(args, ["asset", "out", "speed", "props"], "timeline clips");
      if (!args.source) throw this.invalid("timeline clips need `source`, e.g. `timelines/intro.json`.", { field: "source" });
      const nested = await this.nestedSource(args.source);
      const clipIn = this.grid.snap(args.in ?? 0);
      const duration = args.duration === undefined ? undefined : this.grid.snap(args.duration);
      this.checkNestedBounds(args.source, nested, clipIn, duration);
      clip = {
        id,
        type,
        source: args.source,
        start,
        ...(clipIn > 0 ? { in: clipIn } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...extras,
      };
    } else {
      this.refuse(args, ["asset", "out", "speed"], `${type} clips`);
      if (track.kind === "audio") throw this.invalid(`${type} clips render video; use a video track.`, { field: "track" });
      const adapter = await this.adapter(type);
      if (args.duration === undefined) throw this.invalid(`${type} clips need \`duration\` in seconds.`, { field: "duration" });
      const props = args.props ?? {};
      const problem = await adapter.validateProps(props);
      if (problem) throw this.invalid(`invalid props for ${type}: ${problem}`, { field: "props" });
      const clipIn = this.grid.snap(args.in ?? 0);
      clip = {
        id,
        type,
        ...(args.source ? { source: args.source } : {}),
        start,
        ...(clipIn > 0 ? { in: clipIn } : {}),
        duration: this.grid.snap(args.duration),
        ...(args.props ? { props } : {}),
        ...extras,
      };
    }
    if (args.ripple === true) {
      // Room first, so the new clip is never compared with a clip it pushes away.
      const length = this.grid.snap((await this.span(clip)).end - clip.start);
      const from = this.grid.frame(clip.start);
      for (const other of rippled.flatMap(clipsOf)) {
        if (this.grid.frame(other.start) >= from) other.start = this.grid.snap(other.start + length);
      }
    }
    track.clips.push(clip);
  }

  /**
   * `clip.add` with `snap`: move a new media clip's `in` and `out` into audio
   * pauses, on its own source clock, each inside its `snapBounds` range.
   */
  async snapNewClip(clip: MediaClip, info: SourceInfo, args: OperationArgs<"clip.add">, requestedOut: number): Promise<void> {
    const window = args.snapWindow ?? this.context.snapWindow ?? DEFAULT_SNAP_WINDOW_S;
    const bounds = this.snapBounds(args.snapBounds, { in: args.in ?? 0, out: args.out ?? requestedOut });
    const edge = (time: number, side: EditPoint["edge"], range: SnapRange) =>
      this.resolve(true, { time, clock: "source", edge: side, window, clip: structuredClone(clip) }, range);
    clip.in = this.report("in", clip, args.in ?? 0, this.grid.snap(Math.max(0, await edge(clip.in, "start", bounds.in))));
    clip.out = this.report("out", clip, requestedOut, this.boundOut(await edge(clip.out, "end", bounds.out), clip.in, info, clip.asset));
    if (clip.out <= clip.in) {
      throw this.invalid(`in and out snapped into the same pause (in ${clip.in}, out ${clip.out}).`, {
        field: "snap",
        hint: "Take a range that spans speech, or add it without `snap`.",
      });
    }
  }

  clipMove(args: OperationArgs<"clip.move">): void {
    if (args.start === undefined && args.track === undefined) {
      throw this.invalid("nothing to move.", { hint: "Pass `start` (seconds) and/or `track`." });
    }
    const { track, clip } = this.clip(args.clip);
    let target = track;
    if (args.track !== undefined) {
      target = this.clipTrack(args.track);
      if (target.kind !== track.kind) {
        throw this.invalid(`${clip.id} is on a ${track.kind} track; ${target.id} is a ${target.kind} track.`, {
          field: "track",
          hint: `Pick a ${track.kind} track: ${this.clipTracks().filter((t) => t.kind === track.kind).map((t) => t.id).join(", ")}.`,
        });
      }
      if (target !== track && target.kind === "program") {
        throw this.invalid(`${clip.id} is a shot of group ${(track as ProgramTrack).group}; ${target.id} shows group ${target.group}.`, {
          field: "track",
          hint: "Shots stay on their program track; move it along the track with `start`.",
        });
      }
    }
    if (args.start !== undefined) clip.start = this.grid.snap(args.start);
    if (target !== track) {
      track.clips.splice(clipsOf(track).indexOf(clip), 1);
      clipsOf(target).push(clip);
    }
  }

  async clipTrim(args: OperationArgs<"clip.trim">): Promise<void> {
    const { track, clip } = this.clip(args.clip);
    const rippled = this.rippleScope(args, track);
    const before = { start: clip.start, end: args.ripple === true ? (await this.span(clip)).end : 0 };
    await this.trimEdges(clip, args);
    if (args.ripple === true) await this.rippleTrim(clip, before, rippled);
  }

  /**
   * Tracks a `ripple` moves: every clip track, or the `rippleTracks` named
   * plus `own` (the edited clip's track). `rippleTracks` without `ripple` is
   * refused rather than ignored.
   */
  rippleScope(args: { ripple?: boolean | undefined; rippleTracks?: string[] | undefined }, own: AnyClipTrack): AnyClipTrack[] {
    if (args.rippleTracks === undefined) return this.clipTracks();
    if (args.ripple !== true) throw this.invalid("`rippleTracks` needs `ripple: true`.", { field: "rippleTracks" });
    const named = new Set<Track>(args.rippleTracks.map((id) => this.clipTrack(id)));
    named.add(own);
    return this.clipTracks().filter((track) => named.has(track));
  }

  /**
   * `clip.trim` with `ripple`: put the clip back at its old left edge, then
   * move clips of the `rippled` tracks by what the trim added or removed:
   * those starting at or after the old end by the whole change, those
   * starting inside the old clip by the head change only (they stay with its
   * old first frame). Clips crossing either point stay.
   */
  async rippleTrim(clip: AnyClip, before: { start: number; end: number }, rippled: readonly AnyClipTrack[]): Promise<void> {
    const g = this.grid;
    const head = g.snap(before.start - clip.start);
    clip.start = before.start;
    const total = g.snap((await this.span(clip)).end - before.end);
    const [first, last] = [g.frame(before.start), g.frame(before.end)];
    for (const other of rippled.flatMap(clipsOf)) {
      if (other === clip) continue;
      const at = g.frame(other.start);
      if (at >= last) other.start = g.snap(other.start + total);
      else if (at >= first) other.start = g.snap(other.start + head);
    }
  }

  /** Move the edges `args` names; with `ripple` the left edge may pass timeline 0, {@link Edit.rippleTrim} puts it back. */
  async trimEdges(clip: AnyClip, args: OperationArgs<"clip.trim">): Promise<void> {
    const ripple = args.ripple === true;
    if (args.in !== undefined && args.start !== undefined) throw this.invalid("pass `in` or `start`, not both.", { field: "start" });
    if (args.out !== undefined && args.end !== undefined) throw this.invalid("pass `out` or `end`, not both.", { field: "end" });
    const head = args.in !== undefined || args.start !== undefined;
    const tail = args.out !== undefined || args.end !== undefined;
    if (!head && !tail) throw this.invalid("nothing to trim.", { hint: "Pass `in`/`start` (head) and/or `out`/`end` (tail)." });
    if (isShotClip(clip)) return this.trimShot(clip, args, head);
    const snap = { enabled: args.snap !== false, window: args.snapWindow ?? this.context.snapWindow ?? DEFAULT_SNAP_WINDOW_S };
    const bounds = this.snapBounds(args.snapBounds, { in: args.in, out: args.out });
    // Bounds are source seconds: only `in` and `out` edges take them.
    const edge = (time: number, clock: EditPoint["clock"], side: EditPoint["edge"]) =>
      this.resolve(
        snap.enabled,
        { time, clock, edge: side, window: snap.window, clip: structuredClone(clip) },
        clock === "source" ? (side === "start" ? bounds.in : bounds.out) : {},
      );
    const span = await this.span(clip);

    if (isMedia(clip)) {
      const speed = clip.speed ?? 1;
      const info = await this.context.source(clip.asset);
      let { start, in: clipIn, out } = clip;
      if (args.in !== undefined) {
        clipIn = this.report("in", clip, args.in, this.grid.snap(await edge(args.in, "source", "start")));
        start = this.grid.snap(clip.start + (clipIn - clip.in) / speed);
      } else if (args.start !== undefined) {
        start = this.report("start", clip, args.start, this.grid.snap(await edge(args.start, "timeline", "start")));
        clipIn = this.grid.ceil(clip.in + (start - clip.start) * speed);
      }
      if (args.out !== undefined) {
        out = this.report("out", clip, args.out, this.boundOut(await edge(args.out, "source", "end"), clipIn, info, clip.asset));
      } else if (args.end !== undefined) {
        const end = this.report("end", clip, args.end, this.grid.snap(await edge(args.end, "timeline", "end")));
        out = this.boundOut(this.grid.floor(clip.in + (end - clip.start) * speed), clipIn, info, clip.asset, "end");
      }
      if (clipIn < 0 || (start < 0 && !ripple)) throw this.headLimit(clip, speed, args.in !== undefined, span.end, out);
      if (out <= clipIn) {
        throw this.invalid(`the clip would be empty (in ${clipIn}, out ${out}).`, {
          field: head ? (args.in !== undefined ? "in" : "start") : args.out !== undefined ? "out" : "end",
          hint: "Keep at least one frame, or remove the clip with `clip.remove`.",
        });
      }
      Object.assign(clip, { start, in: clipIn, out });
      return;
    }

    // Generated and nested clips: composition time runs at speed 1.
    const oldIn = clip.in ?? 0;
    let start = clip.start;
    let clipIn = oldIn;
    if (args.in !== undefined) {
      clipIn = this.report("in", clip, args.in, this.grid.snap(await edge(args.in, "source", "start")));
      start = this.grid.snap(clip.start + (clipIn - oldIn));
    } else if (args.start !== undefined) {
      start = this.report("start", clip, args.start, this.grid.snap(await edge(args.start, "timeline", "start")));
      clipIn = this.grid.snap(oldIn + (start - clip.start));
    }
    let end = span.end;
    if (args.out !== undefined) {
      const out = this.report("out", clip, args.out, this.grid.snap(await edge(args.out, "source", "end")));
      end = this.grid.snap(start + (out - clipIn));
    } else if (args.end !== undefined) {
      end = this.report("end", clip, args.end, this.grid.snap(await edge(args.end, "timeline", "end")));
    }
    if (clipIn < 0 || (start < 0 && !ripple)) throw this.headLimit(clip, 1, args.in !== undefined, span.end, oldIn + (span.end - clip.start));
    const duration = this.grid.snap(end - start);
    if (this.grid.frame(duration) < 1) {
      throw this.invalid("the clip would be shorter than one frame.", { hint: "Remove it with `clip.remove` instead." });
    }
    if (isNested(clip)) this.checkNestedBounds(clip.source, await this.nestedOf(clip), clipIn, duration);
    clip.start = start;
    if (clipIn > 0 || clip.in !== undefined) clip.in = clipIn;
    clip.duration = duration;
  }

  /**
   * {@link Edit.trimEdges} for a shot: `in`/`out` are group-clock seconds at
   * speed 1, `out` at most the group's end. Never snapped: a shot change
   * moves pictures, the sound under it is every angle's.
   */
  async trimShot(clip: ShotClip, args: OperationArgs<"clip.trim">, head: boolean): Promise<void> {
    const g = this.grid;
    if (args.snapBounds !== undefined) throw this.invalid("shots are not snapped; they take no `snapBounds`.", { field: "snapBounds" });
    const span = await this.span(clip);
    let { start, in: clipIn, out } = clip;
    if (args.in !== undefined) {
      clipIn = g.snap(args.in);
      start = g.snap(clip.start + (clipIn - clip.in));
    } else if (args.start !== undefined) {
      start = g.snap(args.start);
      clipIn = g.snap(clip.in + (start - clip.start));
    }
    if (args.out !== undefined) out = g.snap(args.out);
    else if (args.end !== undefined) out = g.snap(clip.in + (g.snap(args.end) - clip.start));
    if (clipIn < 0 || (start < 0 && args.ripple !== true)) throw this.headLimit(clip, 1, args.in !== undefined, span.end, out);
    if (out <= clipIn) {
      throw this.invalid(`the shot would be empty (in ${clipIn}, out ${out}).`, {
        field: head ? (args.in !== undefined ? "in" : "start") : args.out !== undefined ? "out" : "end",
        hint: "Keep at least one frame, or remove the shot with `clip.remove`.",
      });
    }
    Object.assign(clip, { start, in: clipIn, out });
  }

  /** Head trim past source or timeline time 0: error with the valid range of the field used. */
  headLimit(clip: AnyClip, speed: number, bySource: boolean, end: number, out: number): RpcError {
    const g = this.grid;
    const oldIn = clip.in ?? 0;
    const minIn = Math.max(0, oldIn - clip.start * speed);
    return this.invalid("the head cannot extend before source time 0 or timeline time 0.", {
      field: bySource ? "in" : "start",
      valid: bySource
        ? { min: g.ceil(minIn), max: g.seconds(g.frame(out) - 1) }
        : { min: g.ceil(clip.start - (oldIn - minIn) / speed), max: g.seconds(g.frame(end) - 1) },
    });
  }

  async clipSplit(args: OperationArgs<"clip.split">): Promise<void> {
    const { track, clip } = this.clip(args.clip);
    const at = this.grid.snap(args.at);
    const span = await this.span(clip);
    const g = this.grid;
    if (g.frame(at) <= g.frame(clip.start) || g.frame(at) >= g.frame(span.end)) {
      throw this.invalid(`split point ${at} is not inside ${clip.id} (${clip.start}–${span.end}).`, {
        field: "at",
        valid: { min: g.seconds(g.frame(clip.start) + 1), max: g.seconds(g.frame(span.end) - 1) },
      });
    }
    const right = structuredClone(clip);
    right.id = this.newId("c");
    this.trimTail(clip, at);
    this.trimHead(right, at);
    if (!this.isEmpty(clip) && !this.isEmpty(right)) {
      clipsOf(track).push(right);
      return;
    }
    throw this.invalid(`splitting ${clip.id} at ${at} leaves an empty part at this speed.`, { field: "at", hint: "Split a frame later or earlier." });
  }

  clipRemove(args: OperationArgs<"clip.remove">): void {
    const { track, clip } = this.clip(args.clip);
    track.clips.splice(clipsOf(track).indexOf(clip), 1);
  }

  async clipSet(args: OperationArgs<"clip.set">): Promise<void> {
    const { track, clip } = this.clip(args.clip);
    const { speed, gain, muted, transform, props, scriptRef } = args;
    if ([speed, gain, muted, transform, props, scriptRef].every((value) => value === undefined)) {
      throw this.invalid("nothing to set.", { hint: "Pass at least one of speed, gain, muted, transform, props, scriptRef." });
    }
    if (typeof scriptRef === "string") this.checkScriptRefShape(scriptRef);
    if (isShotClip(clip)) {
      const given = (["speed", "gain", "muted", "transform", "props"] as const).filter((field) => args[field] !== undefined);
      if (given.length > 0) {
        throw this.invalid(`shots take no ${given.map((f) => `\`${f}\``).join(", ")}; only \`scriptRef\` is set per shot.`, {
          field: given[0]!,
          hint: "A shot plays every angle's sound at the angle's own gain, set on the angle in the timeline's `groups`.",
        });
      }
      if (scriptRef === null) delete clip.scriptRef;
      else if (scriptRef !== undefined) clip.scriptRef = scriptRef;
      return;
    }
    if (speed !== undefined) {
      if (!isMedia(clip)) throw this.invalid(`only media clips take \`speed\`; ${clip.id} is ${clip.type}.`, { field: "speed" });
      if (speed === 1) delete clip.speed;
      else clip.speed = speed;
    }
    if (gain !== undefined || muted !== undefined) {
      clip.audio = { ...clip.audio, ...(gain !== undefined ? { gain } : {}), ...(muted !== undefined ? { muted } : {}) };
    }
    if (transform !== undefined) {
      if (track.kind === "audio") throw this.invalid("audio tracks take no `transform`.", { field: "transform" });
      clip.transform = { ...clip.transform, ...transform };
    }
    if (props !== undefined) {
      if (isMedia(clip) || isNested(clip)) {
        throw this.invalid(`only adapter clips take \`props\`; ${clip.id} is ${clip.type}.`, { field: "props" });
      }
      const problem = await (await this.adapter(clip.type)).validateProps(props);
      if (problem) throw this.invalid(`invalid props for ${clip.type}: ${problem}`, { field: "props" });
      (clip as { props?: Record<string, unknown> }).props = props;
    }
    if (scriptRef === null) delete clip.scriptRef;
    else if (scriptRef !== undefined) clip.scriptRef = scriptRef;
  }

  async cut(args: OperationArgs<"cut">): Promise<void> {
    const g = this.grid;
    const tracks = args.tracks ? args.tracks.map((id) => this.clipTrack(id)) : this.clipTracks();
    if (g.frame(args.to) <= g.frame(args.from)) {
      throw this.invalid(`\`to\` (${g.snap(args.to)}) must be after \`from\` (${g.snap(args.from)}) by at least one frame.`, {
        field: "to",
        valid: { min: g.seconds(g.frame(args.from) + 1), max: Number.MAX_SAFE_INTEGER },
      });
    }
    const snap = { enabled: args.snap !== false, window: args.snapWindow ?? this.context.snapWindow ?? DEFAULT_SNAP_WINDOW_S };
    const clips = tracks.flatMap((track): Clip[] => {
      if (track.kind !== "program") return structuredClone(track.clips);
      const group = programGroup(this.draft, track);
      return group ? track.clips.flatMap((shot) => shotSound(shot, group)) : [];
    });
    const resolve = (time: number, edge: EditPoint["edge"]) =>
      this.resolve(snap.enabled, { time, clock: "timeline", edge, window: snap.window, clips });
    const from = this.report("from", null, args.from, g.snap(await resolve(args.from, "end")));
    const to = this.report("to", null, args.to, g.snap(await resolve(args.to, "start")));
    if (g.frame(to) <= g.frame(from)) {
      throw this.invalid(`both edges snapped into the same pause (from ${args.from} -> ${from}, to ${args.to} -> ${to}).`, {
        field: "to",
        hint: "Cut between two different pauses, or pass `snap: false` (CLI `--no-snap`) to cut exactly.",
      });
    }
    const [F, T] = [g.frame(from), g.frame(to)];
    const shift = to - from;
    for (const track of tracks) {
      const kept: AnyClip[] = [];
      for (const clip of clipsOf(track)) {
        const S = g.frame(clip.start);
        if (S >= T) {
          // After the range: only moves, so its end is not needed (it may be unknown).
          clip.start = g.snap(clip.start - shift);
          kept.push(clip);
          continue;
        }
        const E = g.frame((await this.span(clip)).end);
        if (E <= F) {
          kept.push(clip);
        } else if (S >= F && E <= T) {
          // Entirely inside the range: removed.
        } else if (S < F && E > T) {
          this.warnInsideGenerated(clip);
          const right = structuredClone(clip);
          right.id = this.newId("c");
          this.trimTail(clip, from);
          this.trimHead(right, to);
          right.start = from;
          for (const part of [clip, right]) if (!this.isEmpty(part)) kept.push(part);
        } else if (S < F) {
          this.warnInsideGenerated(clip);
          this.trimTail(clip, from);
          if (!this.isEmpty(clip)) kept.push(clip);
        } else {
          this.warnInsideGenerated(clip);
          this.trimHead(clip, to);
          clip.start = from;
          if (!this.isEmpty(clip)) kept.push(clip);
        }
      }
      clipsOf(track).splice(0, track.clips.length, ...kept);
    }
  }

  /**
   * ADR 0015 decision 5: a cut that trims or splits an adapter clip slices its composition
   * mid-way. Clips removed whole and cuts on a clip's edge are not warned.
   */
  warnInsideGenerated(clip: AnyClip): void {
    if (CORE_CLIP_TYPES.some((type) => type === clip.type)) return;
    const ref = clip.scriptRef ? `, scriptRef ${clip.scriptRef}` : "";
    this.warnings.push(
      `cut falls inside ${clip.type} clip ${clip.id}${ref}: its composition is trimmed or split. ` +
        "Edit the audio before building visuals; re-place the clip against its script scene afterwards.",
    );
  }

  // Multicam

  /**
   * One multicam group from `args.angles` (offsets already measured), its
   * program track on top, and one `grid` shot over the group's whole length.
   */
  async multicamCreate(args: OperationArgs<"multicam.create">): Promise<void> {
    const seen = new Set<string>();
    const angles: Angle[] = [];
    let end = 0;
    for (const given of args.angles) {
      if (seen.has(given.asset)) {
        throw this.invalid(`${given.asset} is listed twice.`, { field: "angles", hint: "Give each person's file once." });
      }
      seen.add(given.asset);
      const info = await this.context.source(given.asset);
      if (!info.video || info.duration === null) {
        throw this.invalid(`${given.asset} has no moving picture; a multicam angle needs a video file.`, {
          field: "angles",
          hint: "Audio-only files and still images cannot be angles.",
        });
      }
      const name = given.name ?? basename(given.asset).replace(/\.[^.]*$/, "");
      const offset = Math.round(given.offset * 1000) / 1000;
      angles.push({ id: this.angleId(name, angles), name, asset: given.asset, offset });
      end = Math.max(end, offset + info.duration);
    }
    const last = this.grid.floor(end);
    if (this.grid.frame(last) < 1) throw this.invalid(`the files add up to less than one frame (${end} s).`, { field: "angles" });
    const id = this.newId("g");
    const group: MulticamGroup = { id, ...(args.name ? { name: args.name } : {}), angles };
    const track: ProgramTrack = {
      id: this.newId("t"),
      kind: "program",
      name: args.name ?? "Multicam",
      group: id,
      clips: [{ id: this.newId("c"), type: "shot", start: 0, in: 0, out: last, shot: "grid", angles: angles.map((angle) => angle.id) }],
    };
    this.draft.groups = [...(this.draft.groups ?? []), group];
    this.draft.tracks.push(track);
  }

  /** Set one angle's offset; shots left past the group's new end are refused by {@link Edit.checkShots}. */
  multicamOffset(args: OperationArgs<"multicam.offset">): void {
    const group = this.draft.groups?.find((candidate) => candidate.id === args.group);
    if (!group) {
      const ids = (this.draft.groups ?? []).map((candidate) => candidate.id);
      throw this.invalid(`no multicam group "${args.group}" in timeline ${this.draft.id}.`, {
        field: "group",
        hint: ids.length > 0 ? `Groups: ${ids.join(", ")}.` : "There are none; make one with `frameshell multicam create`.",
      });
    }
    const angle = group.angles.find((candidate) => candidate.id === args.angle);
    if (!angle) {
      throw this.invalid(`group ${group.id} has no angle "${args.angle}".`, {
        field: "angle",
        hint: `Angles: ${group.angles.map((candidate) => candidate.id).join(", ")}.`,
      });
    }
    angle.offset = Math.round(args.offset * 1000) / 1000;
  }

  /** Angle id from a name: lowercase letters, digits, `-` and `_`; a number is appended on a clash. */
  angleId(name: string, taken: readonly Angle[]): string {
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "angle";
    let id = base;
    for (let n = 2; taken.some((angle) => angle.id === id); n++) id = `${base}-${n}`;
    return id;
  }

  patch(args: TimelinePatch): void {
    let next: Timeline;
    try {
      next = applyPatch(this.draft, args);
    } catch (error) {
      throw this.invalid((error as Error).message);
    }
    this.draft.tracks = next.tracks;
    if (next.groups) this.draft.groups = next.groups;
    else delete this.draft.groups;
  }

  // Finishing

  /** Check rules on what changed, then build the result. */
  async finish(): Promise<AppliedOperation> {
    for (const track of this.draft.tracks) if (track.kind !== "subtitles") sortClips(track);
    const forward = diffTimelines(this.before, this.draft);
    const changedGroups = new Set((forward.groups ?? []).map((entry) => entry.id));
    const changedTracks = new Set([
      ...(forward.tracks ?? []).filter((entry) => entry.track).map((entry) => entry.id),
      ...(forward.clips ?? []).map((entry) => entry.track),
    ]);
    const checked = this.draft.tracks.filter(
      (track): track is AnyClipTrack =>
        track.kind !== "subtitles" && (changedTracks.has(track.id) || (track.kind === "program" && changedGroups.has(track.group))),
    );
    for (const track of checked) await this.checkTrack(track);
    const parsed = parseTimeline(this.draft);
    if (!parsed.ok) throw this.invalid(`the result would not be a valid timeline:\n${parsed.error}`);
    // After the schema: shots name angles of their group.
    for (const track of checked) if (track.kind === "program") await this.checkShots(track);

    const inverse = diffTimelines(this.draft, this.before);
    const changes = await this.changes(forward);
    const timeline = { ...this.draft, revision: this.before.revision + 1 };
    return { timeline, inverse: { op: "timeline.patch", args: inverse }, changes, snaps: this.snaps, warnings: this.warnings };
  }

  /**
   * Clips of one track: at least one frame each, none overlapping. Clips are
   * sorted. A clip whose end is unknown (nested timeline unavailable) passes
   * only when this operation provably kept it valid: content unchanged, and
   * the next clip no closer than before (see {@link Edit.lengthBound}).
   */
  async checkTrack(track: AnyClipTrack): Promise<void> {
    const g = this.grid;
    let previous: { clip: AnyClip; end: number; known: boolean } | null = null;
    for (const clip of clipsOf(track)) {
      const known = await this.end(clip);
      let end: number;
      if (known !== null) {
        end = known;
        if (g.frame(end) - g.frame(clip.start) < 1) {
          throw this.invalid(`${clip.id} would be shorter than one frame (1/${this.context.fps} s).`, {
            hint: "Make it longer, or remove it with `clip.remove`.",
          });
        }
      } else {
        const bound = this.lengthBound(clip);
        if (bound === null) await this.span(clip); // throws the actionable error
        end = clip.start + bound!;
      }
      if (previous && g.frame(clip.start) < g.frame(previous.end)) {
        if (!previous.known) await this.span(previous.clip); // unknown length: overlap cannot be ruled out
        const [a, b] = [previous, { clip, end }];
        throw this.invalid(
          `${a.clip.id} (${a.clip.start}–${a.end}) and ${b.clip.id} (${b.clip.start}–${b.end}) would overlap on track ${track.id}.`,
          {
            hint:
              `Clips on one track cannot overlap: start the later one at ${a.end} or after, ` +
              "trim one of them, or use another track (`track.add`).",
          },
        );
      }
      previous = { clip, end, known: known !== null };
    }
  }

  /**
   * Shots of a program track against its group's media: every shown angle
   * has a picture, and no shot plays past the group's end (the latest angle
   * end, `offset` + asset length). Angle assets must be readable media.
   */
  async checkShots(track: ProgramTrack): Promise<void> {
    const group = programGroup(this.draft, track);
    if (!group) return;
    const g = this.grid;
    let end = 0;
    const pictures = new Map<string, boolean>();
    for (const angle of group.angles) {
      const info = await this.context.source(angle.asset);
      pictures.set(angle.id, info.video);
      end = Math.max(end, info.duration === null ? Number.POSITIVE_INFINITY : angle.offset + info.duration);
    }
    const last = g.floor(end);
    for (const shot of track.clips) {
      const blind = shot.angles.find((id) => pictures.get(id) === false);
      if (blind !== undefined) {
        const angle = group.angles.find((candidate) => candidate.id === blind)!;
        throw this.invalid(`shot ${shot.id} shows angle ${blind}, but ${angle.asset} has no video stream.`, {
          hint: `Show angles with a picture (group ${group.id}: ${group.angles.filter((a) => pictures.get(a.id)).map((a) => a.id).join(", ") || "none"}).`,
        });
      }
      if (shot.out > last + 1e-9) {
        throw this.invalid(`shot ${shot.id} plays group ${group.id} to ${shot.out} s, past its end (${last} s).`, {
          field: "out",
          valid: { min: g.seconds(g.frame(shot.in) + 1), max: last },
        });
      }
    }
  }

  async changes(forward: TimelinePatch): Promise<OperationResult["changes"]> {
    const before = indexIds(this.before);
    const after = indexIds(this.draft);
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const touched: AnyClip[] = [];
    const seen = new Set<string>();
    const sort = (id: string, existedBefore: boolean, existsAfter: boolean) => {
      // A clip moving between tracks appears twice in the patch (delete + upsert).
      if (seen.has(id)) return;
      seen.add(id);
      if (!existedBefore) added.push(id);
      else if (!existsAfter) removed.push(id);
      else updated.push(id);
    };
    for (const { id } of forward.groups ?? []) {
      sort(id, before.groups.has(id), after.groups.has(id));
      // A group's angles are the sound and pictures of its shots.
      for (const timeline of [this.before, this.draft]) {
        for (const track of timeline.tracks) if (track.kind === "program" && track.group === id) touched.push(...track.clips);
      }
    }
    for (const { id } of forward.tracks ?? []) {
      sort(id, before.tracks.has(id), after.tracks.has(id));
      for (const side of [before.tracks.get(id), after.tracks.get(id)]) {
        if (side && side.kind !== "subtitles") touched.push(...side.clips);
      }
    }
    for (const { id } of forward.clips ?? []) {
      sort(id, before.clips.has(id), after.clips.has(id));
      for (const clip of [before.clips.get(id), after.clips.get(id)]) if (clip) touched.push(clip);
    }
    let range: { from: number; to: number | null } | null = null;
    for (const clip of touched) {
      // Unknown end (nested timeline unavailable): bounded by the next clip before this operation, else open.
      const known = await this.end(clip);
      const bound = known === null ? this.lengthBound(clip) : null;
      const end = known ?? (bound !== null && Number.isFinite(bound) ? this.grid.snap(clip.start + bound) : null);
      if (range === null) range = { from: clip.start, to: end };
      else range = { from: Math.min(range.from, clip.start), to: range.to === null || end === null ? null : Math.max(range.to, end) };
    }
    return { added, updated, removed, range };
  }

  // Helpers

  /**
   * Timeline end of `clip` on the grid. Throws NestedTimelineUnavailable
   * naming the clip, its track and the fix when its nested timeline is
   * missing, invalid or cyclic.
   */
  async span(clip: AnyClip): Promise<{ end: number }> {
    try {
      return { end: await clipEnd(clip, this.grid, this.#nested) };
    } catch (error) {
      throw this.nestedError(clip, error);
    }
  }

  /** Like {@link Edit.span}, but null when the nested timeline is unavailable. */
  async end(clip: AnyClip): Promise<number | null> {
    try {
      return await clipEnd(clip, this.grid, this.#nested);
    } catch (error) {
      if (error instanceof NestedTimelineError) return null;
      throw error;
    }
  }

  /** Duration of the timeline nested by an existing clip; errors name the clip. */
  async nestedOf(clip: TimelineClip): Promise<number> {
    try {
      return await this.#nested(clip.source);
    } catch (error) {
      throw this.nestedError(clip, error);
    }
  }

  /** Duration of a `source` arg (`clip.add`); errors blame the arg. */
  async nestedSource(source: string): Promise<number> {
    try {
      return await this.#nested(source);
    } catch (error) {
      if (!(error instanceof NestedTimelineError)) throw error;
      if (error.reason === "cycle") {
        throw this.invalid(`${error.message}. Nested timelines cannot form a cycle.`, { field: "source" });
      }
      if (error.reason === "missing" && error.chain.length === 1) {
        const available = error.available;
        throw new RpcError(
          ErrorCode.TimelineNotFound,
          `${this.op}: no timeline file ${source}` +
            (available.length > 0 ? `; timelines: ${available.join(", ")} (pass the id, e.g. \`${available[0]}\`).` : "."),
          { timeline: source, path: source, available: [...available] },
        );
      }
      throw this.invalid(`${source} has no derivable length: ${error.message}.`, {
        field: "source",
        hint: `Fix ${error.broken} first.`,
      });
    }
  }

  /** Wrap a nested timeline failure of an existing clip in an actionable error; rethrow anything else. */
  nestedError(clip: AnyClip, error: unknown): unknown {
    if (!(error instanceof NestedTimelineError)) return error;
    const track = [this.draft, this.before]
      .flatMap((timeline) => timeline.tracks)
      .find((t) => t.kind !== "subtitles" && t.clips.some((c) => c.id === clip.id));
    return nestedClipError(error, { timeline: this.draft.id, track: track?.id ?? "?", clip, op: this.op });
  }

  /**
   * Upper bound of the length of a clip with unknown end, from the timeline
   * before this operation: the gap to the next clip on its old track
   * (Infinity when last). Valid only while its content is unchanged, so
   * null when the clip is new or anything but `start` changed.
   */
  lengthBound(clip: AnyClip): number | null {
    for (const track of this.before.tracks) {
      if (track.kind === "subtitles") continue;
      const index = track.clips.findIndex((c) => c.id === clip.id);
      if (index < 0) continue;
      const old = track.clips[index]!;
      if (JSON.stringify({ ...old, start: 0 }) !== JSON.stringify({ ...clip, start: 0 })) return null;
      const next = track.clips[index + 1];
      return next ? next.start - old.start : Number.POSITIVE_INFINITY;
    }
    return null;
  }

  /** Nested durations, looked up once per operation (failures too). */
  readonly #nested = (source: string): Promise<number> => {
    let duration = this.#spans.get(source);
    if (duration === undefined) {
      duration = this.context.nestedDuration(source);
      this.#spans.set(source, duration);
    }
    return duration;
  };

  /**
   * Run `point` through the context's resolver unless snapping is off. The
   * resolution waits in `#pending` until {@link Edit.report} pairs it with
   * the final grid time.
   */
  async resolve(enabled: boolean, point: EditPoint, bounds: SnapRange = {}): Promise<number> {
    this.#pending = null;
    if (!enabled || !this.context.resolveEditPoint) return point.time;
    const resolution = await this.context.resolveEditPoint({
      ...point,
      ...(bounds.min !== undefined ? { min: bounds.min } : {}),
      ...(bounds.max !== undefined ? { max: bounds.max } : {}),
    });
    if (!resolution) return point.time;
    this.#pending = { clean: resolution.clean, window: point.window };
    return this.clampToGrid(resolution.time, bounds);
  }

  /**
   * `time` on the frame grid inside `bounds`: the nearest in-range frame when
   * the resolver ignored them. A range narrower than a frame keeps `min`.
   */
  clampToGrid(time: number, bounds: SnapRange): number {
    const g = this.grid;
    if (bounds.min === undefined && bounds.max === undefined) return time;
    let value = g.snap(time);
    if (bounds.max !== undefined && value > bounds.max + 1e-9) value = g.floor(bounds.max);
    if (bounds.min !== undefined && value < bounds.min - 1e-9) value = g.ceil(bounds.min);
    return value;
  }

  /**
   * Check op `snapBounds` against the edges requested: a range needs its
   * edge, `min <= max`, and the requested time inside it.
   */
  snapBounds(
    bounds: { in?: SnapRange | undefined; out?: SnapRange | undefined } | undefined,
    requested: { in: number | undefined; out: number | undefined },
  ): { in: SnapRange; out: SnapRange } {
    for (const field of ["in", "out"] as const) {
      const range = bounds?.[field];
      if (!range) continue;
      const time = requested[field];
      if (time === undefined) throw this.invalid(`\`snapBounds.${field}\` needs \`${field}\`.`, { field: "snapBounds" });
      const min = range.min ?? 0;
      const max = range.max ?? Number.POSITIVE_INFINITY;
      if (min > max) throw this.invalid(`\`snapBounds.${field}\` has min ${min} past max ${max}.`, { field: "snapBounds" });
      if (time < min - 1e-9 || time > max + 1e-9) {
        throw this.invalid(`${field} ${time} lies outside its \`snapBounds\`.`, { field: "snapBounds", valid: { min, max } });
      }
    }
    return { in: bounds?.in ?? {}, out: bounds?.out ?? {} };
  }

  /** Record the last resolved edge as a snap of `field`; returns `applied`. */
  report(field: SnapReport["field"], clip: AnyClip | null, requested: number, applied: number): number {
    if (this.#pending) this.snaps.push({ field, clip: clip?.id ?? null, requested, applied, ...this.#pending });
    this.#pending = null;
    return applied;
  }

  /** Keep `clip` up to timeline time `at` (a grid time inside it). */
  trimTail(clip: AnyClip, at: number): void {
    if (isMedia(clip) || isShotClip(clip)) {
      clip.out = this.grid.floor(clip.in + (at - clip.start) * speedOf(clip));
    } else {
      clip.duration = this.grid.snap(at - clip.start);
    }
  }

  /** Drop `clip` before timeline time `at` (a grid time inside it); start moves to `at`. */
  trimHead(clip: AnyClip, at: number): void {
    const delta = at - clip.start;
    if (isMedia(clip) || isShotClip(clip)) {
      clip.in = this.grid.ceil(clip.in + delta * speedOf(clip));
    } else {
      clip.in = this.grid.snap((clip.in ?? 0) + delta);
      if (clip.duration !== undefined) clip.duration = this.grid.snap(clip.duration - delta);
    }
    clip.start = this.grid.snap(at);
  }

  isEmpty(clip: AnyClip): boolean {
    if (isMedia(clip) || isShotClip(clip)) return clip.out <= clip.in;
    return clip.duration !== undefined && this.grid.frame(clip.duration) < 1;
  }

  /** Last frame boundary of a source, on the grid; unbounded for stills. */
  maxOut(info: SourceInfo): number {
    return info.duration === null ? Number.POSITIVE_INFINITY : this.grid.floor(info.duration);
  }

  /**
   * Snap a requested source `out` and keep it inside the source. A value
   * within the source's own duration that snaps one frame past the grid end
   * is clamped (asking for the full length always works).
   */
  boundOut(raw: number, clipIn: number, info: SourceInfo, asset: string, field: "out" | "end" = "out"): number {
    const maxOut = this.maxOut(info);
    const out = this.grid.snap(raw);
    if (out <= maxOut) return out;
    if (info.duration !== null && raw <= info.duration + 0.0005) return maxOut;
    throw this.invalid(`out ${out} is past the end of ${asset} (${maxOut} s on the ${this.context.fps} fps grid).`, {
      field,
      valid: { min: this.grid.seconds(this.grid.frame(clipIn) + 1), max: maxOut },
    });
  }

  checkNestedBounds(source: string, nested: number, clipIn: number, duration: number | undefined): void {
    const g = this.grid;
    const end = g.floor(nested);
    if (g.frame(clipIn) >= g.frame(end)) {
      throw this.invalid(`in ${clipIn} is at or past the end of ${source} (${end} s).`, {
        field: "in",
        valid: { min: 0, max: g.seconds(g.frame(end) - 1) },
      });
    }
    if (duration !== undefined && g.frame(clipIn + duration) > g.frame(end)) {
      throw this.invalid(`in + duration (${g.snap(clipIn + duration)}) is past the end of ${source} (${end} s).`, {
        field: "duration",
        valid: { min: g.seconds(1), max: g.snap(end - clipIn) },
      });
    }
  }

  async trackEnd(track: AnyClipTrack): Promise<number> {
    let end = 0;
    for (const clip of track.clips) end = Math.max(end, (await this.span(clip)).end);
    return end;
  }

  async adapter(type: string): Promise<ClipTypeInfo> {
    const types = await this.context.clipTypes();
    const adapter = types.get(type);
    if (adapter) return adapter;
    const available = ["media", "timeline", ...types.keys()].join(", ");
    throw this.invalid(`clip type "${type}" is not registered (available: ${available}).`, {
      field: "type",
      hint: "Install and trust the plugin that provides it: `frameshell plugin install <spec>`, then `frameshell plugin list`.",
    });
  }

  /** Reject args that do not apply to this clip type. */
  refuse(args: Record<string, unknown>, fields: string[], what: string): void {
    const given = fields.filter((field) => args[field] !== undefined);
    if (given.length > 0) {
      throw this.invalid(`${what} take no ${given.map((f) => `\`${f}\``).join(", ")}.`, { field: given[0]! });
    }
  }

  track(id: string): Track {
    const track = this.draft.tracks.find((candidate) => candidate.id === id);
    if (track) return track;
    const available = this.draft.tracks.map((candidate) => candidate.id);
    throw new RpcError(
      ErrorCode.TrackNotFound,
      `${this.op}: no track "${id}" in timeline ${this.draft.id}` +
        (available.length > 0 ? ` (tracks: ${available.join(", ")}).` : ". It has no tracks yet: add one with `track add`."),
      { track: id, available },
    );
  }

  clipTrack(id: string): AnyClipTrack {
    const track = this.track(id);
    if (track.kind !== "subtitles") return track;
    throw this.invalid(`${id} is a subtitle track; its words come from ${track.follows}, it holds no clips.`, {
      field: "track",
      hint: `Clip tracks: ${this.clipTracks().map((t) => t.id).join(", ") || "none"}.`,
    });
  }

  /** Video, audio and program tracks, in stacking order. */
  clipTracks(): AnyClipTrack[] {
    return this.draft.tracks.filter((track): track is AnyClipTrack => track.kind !== "subtitles");
  }

  /** Video and audio tracks, in stacking order. */
  mediaTracks(): ClipTrack[] {
    return this.draft.tracks.filter((track): track is ClipTrack => track.kind === "video" || track.kind === "audio");
  }

  clip(id: string): { track: AnyClipTrack; clip: AnyClip } {
    for (const track of this.clipTracks()) {
      const clip = clipsOf(track).find((candidate) => candidate.id === id);
      if (clip) return { track, clip };
    }
    throw new RpcError(
      ErrorCode.ClipNotFound,
      `${this.op}: no clip "${id}" in timeline ${this.draft.id}. List clip ids with \`frameshell timeline show\`.`,
      { clip: id },
    );
  }

  newId(prefix: "c" | "t" | "g"): string {
    // Ids removed by this same operation stay taken: one id never names two things in one change.
    const taken = [indexIds(this.draft), indexIds(this.before)];
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = this.context.newId(prefix);
      if (taken.every(({ tracks, clips, groups }) => !tracks.has(id) && !clips.has(id) && !groups.has(id))) return id;
    }
    throw new Error(`could not generate a free ${prefix}_ id`);
  }

  /** Refuse a `scriptRef` that can never name a project file (absolute, `..`); a missing script is only warned about later. */
  checkScriptRefShape(ref: string): void {
    const problem = scriptRefPathProblem(splitScriptRef(ref).path);
    if (problem) {
      throw this.invalid(`scriptRef "${ref}" ${problem}.`, {
        field: "scriptRef",
        hint: "Use a project-relative script path, plus `#scene` for one scene, e.g. `scripts/script.md#intro` (see `frameshell script outline`).",
      });
    }
  }

  /** `Unsupported`: a valid request this version cannot carry out yet. */
  unsupported(reason: string, data: { feature: string; hint: string }): RpcError {
    return new RpcError(ErrorCode.Unsupported, `${this.op}: ${reason} ${data.hint}`, { op: this.op, ...data });
  }

  invalid(reason: string, extra: { field?: string; valid?: { min: number; max: number }; hint?: string } = {}): RpcError {
    const range = extra.valid
      ? ` Valid${extra.field ? ` ${extra.field}` : ""}: ${extra.valid.min}${extra.valid.max === Number.MAX_SAFE_INTEGER || extra.valid.max === Number.POSITIVE_INFINITY ? " or more" : ` to ${extra.valid.max}`} s.`
      : "";
    const hint = extra.hint ? ` ${extra.hint}` : "";
    return new RpcError(ErrorCode.InvalidOperation, `${this.op}: ${reason}${range}${hint}`, {
      op: this.op,
      reason,
      ...extra,
    });
  }
}

/** Adapter `type` is any string, so `clip.type === "media"` alone does not narrow. */
function isMedia(clip: AnyClip): clip is MediaClip {
  return clip.type === "media";
}

function isNested(clip: AnyClip): clip is TimelineClip {
  return clip.type === "timeline";
}

/** Source seconds per timeline second; shots run at 1. */
function speedOf(clip: MediaClip | ShotClip): number {
  return isShotClip(clip) ? 1 : (clip.speed ?? 1);
}

/**
 * `track.clips` typed as any clip, for code that moves clips without caring
 * about their kind; {@link Edit.finish} validates kinds against tracks.
 */
function clipsOf(track: AnyClipTrack): AnyClip[] {
  return track.clips;
}

function indexIds(timeline: Timeline): { tracks: Map<string, Track>; clips: Map<string, AnyClip>; groups: Set<string> } {
  const tracks = new Map<string, Track>();
  const clips = new Map<string, AnyClip>();
  for (const track of timeline.tracks) {
    tracks.set(track.id, track);
    if (track.kind !== "subtitles") for (const clip of track.clips) clips.set(clip.id, clip);
  }
  return { tracks, clips, groups: new Set((timeline.groups ?? []).map((group) => group.id)) };
}
