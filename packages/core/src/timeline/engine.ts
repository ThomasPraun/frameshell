import {
  ErrorCode,
  type OperationName,
  type OperationResult,
  RpcError,
  type TimelinePatch,
  type operationArgs,
} from "@frameshell/protocol";
import {
  type Clip,
  type ClipTrack,
  type MediaClip,
  type TimelineClip,
  type Timeline,
  type Track,
  parseTimeline,
} from "@frameshell/schema";
import type { z } from "zod";
import { FrameGrid } from "./grid.js";
import { applyPatch, diffTimelines, sortClips } from "./patch.js";
import { clipEnd } from "./timing.js";

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
 * (#12) plugs in here to move edges into silence; the default keeps them.
 */
export interface EditPoint {
  /** Seconds on {@link EditPoint.clock}. */
  time: number;
  /** `timeline` for `cut` and trims by `start`/`end`; `source` for trims by `in`/`out`. */
  clock: "timeline" | "source";
  /** `start`: first kept frame after removed material; `end`: removed material follows. */
  edge: "start" | "end";
  /** Clip being trimmed; absent for `cut`, which spans tracks. */
  clip?: Clip;
}

/** See {@link EditPoint}. Returns the adjusted time, same clock. */
export type EditPointResolver = (point: EditPoint) => number | Promise<number>;

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
  /** Derived duration of a nested timeline file (project-relative). Throws when missing, invalid or cyclic. */
  nestedDuration(source: string): Promise<number>;
  /** Adapter clip types loaded for the project; empty when plugins are untrusted. */
  clipTypes(): Promise<ReadonlyMap<string, ClipTypeInfo>>;
  /** Fresh id with prefix `c` (clip) or `t` (track); the engine retries on collision. */
  newId(prefix: "c" | "t"): string;
  /** Edge adjustment seam for `cut` and `clip.trim` (#12). Default: identity. */
  resolveEditPoint?: EditPointResolver;
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
  readonly #spans = new Map<string, number>();

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
      case "timeline.patch":
        return this.patch(request.args);
    }
  }

  // Tracks

  trackAdd(args: OperationArgs<"track.add">): void {
    const { kind, name, follows, index } = args;
    if (kind === "subtitles") {
      if (follows === undefined) {
        throw this.invalid("a subtitle track needs `follows`: the video or audio track whose words it shows.", {
          field: "follows",
          hint: `Clip tracks here: ${this.clipTracks().map((t) => t.id).join(", ") || "none, add one first"}.`,
        });
      }
      const followed = this.track(follows);
      if (followed.kind === "subtitles") {
        throw this.invalid(`\`follows\` must name a video or audio track; ${follows} is a subtitle track.`, { field: "follows" });
      }
    } else if (follows !== undefined) {
      throw this.invalid("only subtitle tracks take `follows`.", { field: "follows" });
    }
    const count = this.draft.tracks.length;
    if (index !== undefined && index > count) {
      throw this.invalid(`index ${index} is past the top of the stack.`, { field: "index", valid: { min: 0, max: count } });
    }
    const id = this.newId("t");
    const track: Track =
      kind === "subtitles"
        ? { id, kind, ...(name ? { name } : {}), follows: follows! }
        : { id, kind, ...(name ? { name } : {}), clips: [] };
    this.draft.tracks.splice(index ?? count, 0, track);
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
    const track = this.clipTrack(args.track);
    const { type } = args;
    if (track.kind === "audio" && args.transform) throw this.invalid("audio tracks take no `transform`.", { field: "transform" });
    const extras = {
      ...(args.transform ? { transform: args.transform } : {}),
      ...(args.gain !== undefined || args.muted !== undefined
        ? { audio: { ...(args.gain !== undefined ? { gain: args.gain } : {}), ...(args.muted !== undefined ? { muted: args.muted } : {}) } }
        : {}),
      ...(args.scriptRef ? { scriptRef: args.scriptRef } : {}),
    };
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
      clip = { id, type, asset: args.asset, start, in: clipIn, out, ...(speed !== 1 ? { speed } : {}), ...extras };
    } else if (type === "timeline") {
      this.refuse(args, ["asset", "out", "speed", "props"], "timeline clips");
      if (!args.source) throw this.invalid("timeline clips need `source`, e.g. `timelines/intro.json`.", { field: "source" });
      const nested = await this.context.nestedDuration(args.source);
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
    track.clips.push(clip);
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
    }
    if (args.start !== undefined) clip.start = this.grid.snap(args.start);
    if (target !== track) {
      track.clips.splice(track.clips.indexOf(clip), 1);
      target.clips.push(clip);
    }
  }

  async clipTrim(args: OperationArgs<"clip.trim">): Promise<void> {
    const { clip } = this.clip(args.clip);
    if (args.in !== undefined && args.start !== undefined) throw this.invalid("pass `in` or `start`, not both.", { field: "start" });
    if (args.out !== undefined && args.end !== undefined) throw this.invalid("pass `out` or `end`, not both.", { field: "end" });
    const head = args.in !== undefined || args.start !== undefined;
    const tail = args.out !== undefined || args.end !== undefined;
    if (!head && !tail) throw this.invalid("nothing to trim.", { hint: "Pass `in`/`start` (head) and/or `out`/`end` (tail)." });
    const edge = async (time: number, clock: EditPoint["clock"], side: EditPoint["edge"]) =>
      (await this.context.resolveEditPoint?.({ time, clock, edge: side, clip: structuredClone(clip) })) ?? time;
    const span = await this.span(clip);

    if (isMedia(clip)) {
      const speed = clip.speed ?? 1;
      const info = await this.context.source(clip.asset);
      let { start, in: clipIn, out } = clip;
      if (args.in !== undefined) {
        clipIn = this.grid.snap(await edge(args.in, "source", "start"));
        start = this.grid.snap(clip.start + (clipIn - clip.in) / speed);
      } else if (args.start !== undefined) {
        start = this.grid.snap(await edge(args.start, "timeline", "start"));
        clipIn = this.grid.ceil(clip.in + (start - clip.start) * speed);
      }
      if (args.out !== undefined) {
        out = this.boundOut(await edge(args.out, "source", "end"), clipIn, info, clip.asset);
      } else if (args.end !== undefined) {
        const end = this.grid.snap(await edge(args.end, "timeline", "end"));
        out = this.boundOut(this.grid.floor(clip.in + (end - clip.start) * speed), clipIn, info, clip.asset, "end");
      }
      if (clipIn < 0 || start < 0) throw this.headLimit(clip, speed, args.in !== undefined, span.end, out);
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
      clipIn = this.grid.snap(await edge(args.in, "source", "start"));
      start = this.grid.snap(clip.start + (clipIn - oldIn));
    } else if (args.start !== undefined) {
      start = this.grid.snap(await edge(args.start, "timeline", "start"));
      clipIn = this.grid.snap(oldIn + (start - clip.start));
    }
    let end = span.end;
    if (args.out !== undefined) end = this.grid.snap(start + (this.grid.snap(await edge(args.out, "source", "end")) - clipIn));
    else if (args.end !== undefined) end = this.grid.snap(await edge(args.end, "timeline", "end"));
    if (clipIn < 0 || start < 0) throw this.headLimit(clip, 1, args.in !== undefined, span.end, oldIn + (span.end - clip.start));
    const duration = this.grid.snap(end - start);
    if (this.grid.frame(duration) < 1) {
      throw this.invalid("the clip would be shorter than one frame.", { hint: "Remove it with `clip.remove` instead." });
    }
    if (isNested(clip)) this.checkNestedBounds(clip.source, await this.context.nestedDuration(clip.source), clipIn, duration);
    clip.start = start;
    if (clipIn > 0 || clip.in !== undefined) clip.in = clipIn;
    clip.duration = duration;
  }

  /** Head trim past source or timeline time 0: error with the valid range of the field used. */
  headLimit(clip: Clip, speed: number, bySource: boolean, end: number, out: number): RpcError {
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
      track.clips.push(right);
      return;
    }
    throw this.invalid(`splitting ${clip.id} at ${at} leaves an empty part at this speed.`, { field: "at", hint: "Split a frame later or earlier." });
  }

  clipRemove(args: OperationArgs<"clip.remove">): void {
    const { track, clip } = this.clip(args.clip);
    track.clips.splice(track.clips.indexOf(clip), 1);
  }

  async clipSet(args: OperationArgs<"clip.set">): Promise<void> {
    const { track, clip } = this.clip(args.clip);
    const { speed, gain, muted, transform, props, scriptRef } = args;
    if ([speed, gain, muted, transform, props, scriptRef].every((value) => value === undefined)) {
      throw this.invalid("nothing to set.", { hint: "Pass at least one of speed, gain, muted, transform, props, scriptRef." });
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
    const resolve = async (time: number, edge: EditPoint["edge"]) =>
      (await this.context.resolveEditPoint?.({ time, clock: "timeline", edge })) ?? time;
    const from = g.snap(await resolve(args.from, "end"));
    const to = g.snap(await resolve(args.to, "start"));
    if (g.frame(to) <= g.frame(from)) {
      throw this.invalid(`\`to\` (${to}) must be after \`from\` (${from}) by at least one frame.`, {
        field: "to",
        valid: { min: g.seconds(g.frame(from) + 1), max: Number.MAX_SAFE_INTEGER },
      });
    }
    const tracks = args.tracks ? args.tracks.map((id) => this.clipTrack(id)) : this.clipTracks();
    const [F, T] = [g.frame(from), g.frame(to)];
    const shift = to - from;
    for (const track of tracks) {
      const kept: Clip[] = [];
      for (const clip of track.clips) {
        const span = await this.span(clip);
        const [S, E] = [g.frame(clip.start), g.frame(span.end)];
        if (E <= F) {
          kept.push(clip);
        } else if (S >= T) {
          clip.start = g.snap(clip.start - shift);
          kept.push(clip);
        } else if (S >= F && E <= T) {
          // Entirely inside the range: removed.
        } else if (S < F && E > T) {
          const right = structuredClone(clip);
          right.id = this.newId("c");
          this.trimTail(clip, from);
          this.trimHead(right, to);
          right.start = from;
          for (const part of [clip, right]) if (!this.isEmpty(part)) kept.push(part);
        } else if (S < F) {
          this.trimTail(clip, from);
          if (!this.isEmpty(clip)) kept.push(clip);
        } else {
          this.trimHead(clip, to);
          clip.start = from;
          if (!this.isEmpty(clip)) kept.push(clip);
        }
      }
      track.clips = kept;
    }
  }

  patch(args: TimelinePatch): void {
    let next: Timeline;
    try {
      next = applyPatch(this.draft, args);
    } catch (error) {
      throw this.invalid((error as Error).message);
    }
    this.draft.tracks = next.tracks;
  }

  // Finishing

  /** Check rules on what changed, then build the result. */
  async finish(): Promise<AppliedOperation> {
    for (const track of this.draft.tracks) if (track.kind !== "subtitles") sortClips(track);
    const forward = diffTimelines(this.before, this.draft);
    const changedTracks = new Set([
      ...(forward.tracks ?? []).filter((entry) => entry.track).map((entry) => entry.id),
      ...(forward.clips ?? []).map((entry) => entry.track),
    ]);
    for (const track of this.draft.tracks) {
      if (track.kind !== "subtitles" && changedTracks.has(track.id)) await this.checkTrack(track);
    }
    const parsed = parseTimeline(this.draft);
    if (!parsed.ok) throw this.invalid(`the result would not be a valid timeline:\n${parsed.error}`);

    const inverse = diffTimelines(this.draft, this.before);
    const changes = await this.changes(forward);
    const timeline = { ...this.draft, revision: this.before.revision + 1 };
    return { timeline, inverse: { op: "timeline.patch", args: inverse }, changes };
  }

  /** Clips of one track: at least one frame each, none overlapping. Clips are sorted. */
  async checkTrack(track: ClipTrack): Promise<void> {
    const g = this.grid;
    let previous: { clip: Clip; end: number } | null = null;
    for (const clip of track.clips) {
      const span = await this.span(clip);
      if (g.frame(span.end) - g.frame(clip.start) < 1) {
        throw this.invalid(`${clip.id} would be shorter than one frame (1/${this.context.fps} s).`, {
          hint: "Make it longer, or remove it with `clip.remove`.",
        });
      }
      if (previous && g.frame(clip.start) < g.frame(previous.end)) {
        const [a, b] = [previous, { clip, end: span.end }];
        throw this.invalid(
          `${a.clip.id} (${a.clip.start}–${a.end}) and ${b.clip.id} (${b.clip.start}–${b.end}) would overlap on track ${track.id}.`,
          {
            hint:
              `Clips on one track cannot overlap: start the later one at ${a.end} or after, ` +
              "trim one of them, or use another track (`track.add`).",
          },
        );
      }
      previous = { clip, end: span.end };
    }
  }

  async changes(forward: TimelinePatch): Promise<OperationResult["changes"]> {
    const before = indexIds(this.before);
    const after = indexIds(this.draft);
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const touched: Clip[] = [];
    const seen = new Set<string>();
    const sort = (id: string, existedBefore: boolean, existsAfter: boolean) => {
      // A clip moving between tracks appears twice in the patch (delete + upsert).
      if (seen.has(id)) return;
      seen.add(id);
      if (!existedBefore) added.push(id);
      else if (!existsAfter) removed.push(id);
      else updated.push(id);
    };
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
    let range: { from: number; to: number } | null = null;
    for (const clip of touched) {
      const { end } = await this.span(clip);
      range = range ? { from: Math.min(range.from, clip.start), to: Math.max(range.to, end) } : { from: clip.start, to: end };
    }
    return { added, updated, removed, range };
  }

  // Helpers

  /** Timeline end of `clip` on the grid. */
  async span(clip: Clip): Promise<{ end: number }> {
    return { end: await clipEnd(clip, this.grid, this.#nested) };
  }

  /** Nested durations, looked up once per operation. */
  readonly #nested = async (source: string): Promise<number> => {
    let duration = this.#spans.get(source);
    if (duration === undefined) {
      duration = await this.context.nestedDuration(source);
      this.#spans.set(source, duration);
    }
    return duration;
  };

  /** Keep `clip` up to timeline time `at` (a grid time inside it). */
  trimTail(clip: Clip, at: number): void {
    if (isMedia(clip)) {
      clip.out = this.grid.floor(clip.in + (at - clip.start) * (clip.speed ?? 1));
    } else {
      clip.duration = this.grid.snap(at - clip.start);
    }
  }

  /** Drop `clip` before timeline time `at` (a grid time inside it); start moves to `at`. */
  trimHead(clip: Clip, at: number): void {
    const delta = at - clip.start;
    if (isMedia(clip)) {
      clip.in = this.grid.ceil(clip.in + delta * (clip.speed ?? 1));
    } else {
      clip.in = this.grid.snap((clip.in ?? 0) + delta);
      if (clip.duration !== undefined) clip.duration = this.grid.snap(clip.duration - delta);
    }
    clip.start = this.grid.snap(at);
  }

  isEmpty(clip: Clip): boolean {
    if (isMedia(clip)) return clip.out <= clip.in;
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

  async trackEnd(track: ClipTrack): Promise<number> {
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

  clipTrack(id: string): ClipTrack {
    const track = this.track(id);
    if (track.kind !== "subtitles") return track;
    throw this.invalid(`${id} is a subtitle track; its words come from ${track.follows}, it holds no clips.`, {
      field: "track",
      hint: `Clip tracks: ${this.clipTracks().map((t) => t.id).join(", ") || "none"}.`,
    });
  }

  clipTracks(): ClipTrack[] {
    return this.draft.tracks.filter((track): track is ClipTrack => track.kind !== "subtitles");
  }

  clip(id: string): { track: ClipTrack; clip: Clip } {
    for (const track of this.clipTracks()) {
      const clip = track.clips.find((candidate) => candidate.id === id);
      if (clip) return { track, clip };
    }
    throw new RpcError(
      ErrorCode.ClipNotFound,
      `${this.op}: no clip "${id}" in timeline ${this.draft.id}. List clip ids with \`frameshell timeline show\`.`,
      { clip: id },
    );
  }

  newId(prefix: "c" | "t"): string {
    // Ids removed by this same operation stay taken: one id never names two things in one change.
    const taken = [indexIds(this.draft), indexIds(this.before)];
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = this.context.newId(prefix);
      if (taken.every(({ tracks, clips }) => !tracks.has(id) && !clips.has(id))) return id;
    }
    throw new Error(`could not generate a free ${prefix}_ id`);
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
function isMedia(clip: Clip): clip is MediaClip {
  return clip.type === "media";
}

function isNested(clip: Clip): clip is TimelineClip {
  return clip.type === "timeline";
}


function indexIds(timeline: Timeline): { tracks: Map<string, Track>; clips: Map<string, Clip> } {
  const tracks = new Map<string, Track>();
  const clips = new Map<string, Clip>();
  for (const track of timeline.tracks) {
    tracks.set(track.id, track);
    if (track.kind !== "subtitles") for (const clip of track.clips) clips.set(clip.id, clip);
  }
  return { tracks, clips };
}
