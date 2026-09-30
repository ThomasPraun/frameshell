import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type MediaProbe,
  type OperationRecord,
  type OperationResult,
  RpcError,
  type TimelineProblem,
  type TimelineView,
  type TrackSummary,
} from "@frameshell/protocol";
import type { ClipAdapter } from "@frameshell/plugin-api";
import { type Timeline, parseTimeline } from "@frameshell/schema";
import { writeJsonAtomic } from "../fs-util.js";
import { ToolError } from "../media/ffmpeg.js";
import { readEnclosingProject } from "../projects.js";
import { type ClipTypeInfo, type EditContext, type EditPointResolver, type OperationRequest, applyOperation } from "./engine.js";
import { FrameGrid } from "./grid.js";
import { NestedTimelineError, clipEnd, nestedClipError, timelineDuration } from "./timing.js";

/** Options for {@link TimelineService}. */
export interface TimelineServiceOptions {
  /** ffprobe summary of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Clip adapters loaded for the project; see `PluginHost.clipTypes`. */
  clipTypes(root: string): Promise<ReadonlyMap<string, ClipAdapter>>;
  /** Id generator. Default: prefix + 6 random hex digits (`c_1a2b3c`). */
  newId?: (prefix: "c" | "t") => string;
  /** Cut/trim edge adjustment (#12 energy snapping). Default: none. */
  resolveEditPoint?: (root: string) => EditPointResolver | undefined;
}

/** Operation to run: the engine request plus who asked. */
export interface TimelineCall {
  /** Project root. */
  root: string;
  /** Caller's directory: relative `asset`/`source` args resolve against it first. */
  cwd: string;
  /** Timeline id (`timelines/<id>.json`). */
  timeline: string;
  request: OperationRequest;
  /** SPEC §6.2 author: `ui`, `cli:<session>`, `cli`, … */
  author: string;
}

/**
 * The daemon's timeline files (SPEC §6.1): loads a timeline, runs one
 * operation through the engine with project facts (fps, media probes,
 * nested timelines, plugin clip types), writes the result atomically and
 * returns the operation record. Operations on one file are serialized; the
 * file is re-read each time, so it stays the source of truth.
 */
export class TimelineService {
  readonly #options: TimelineServiceOptions;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: TimelineServiceOptions) {
    this.#options = options;
  }

  /** Apply one operation. Throws the engine's errors, TimelineNotFound or InvalidProjectFile. */
  apply(call: TimelineCall): Promise<OperationResult> {
    const { root, timeline: id } = call;
    return this.#exclusive(timelinePath(root, id), async () => {
      const { timeline, fps } = await this.load(root, id);
      const request = normalizeArgs(call);
      const applied = await applyOperation(timeline, request, this.#context(root, id, fps, request.op));
      await writeJsonAtomic(timelinePath(root, id), applied.timeline);
      const operation: OperationRecord = {
        op: request.op,
        args: request.args as Record<string, unknown>,
        inverse: applied.inverse,
        author: call.author,
        tx: null,
        revisionBefore: timeline.revision,
      };
      return { timeline: id, revision: applied.timeline.revision, operation, changes: applied.changes };
    });
  }

  /**
   * Compact dump for agents (`timeline.show`). A clip whose nested timeline
   * is missing, invalid or cyclic does not fail the dump: its `end` is null,
   * the track end and duration are null, and `problems` says how to fix it.
   */
  async show(root: string, id: string): Promise<TimelineView> {
    const { timeline, fps } = await this.load(root, id);
    const grid = new FrameGrid(fps);
    const resolve = this.#nestedDurations(root, [timelineRel(id)], grid);
    const durations = new Map<string, Promise<number>>();
    const nested = (source: string) => {
      let duration = durations.get(source);
      if (!duration) durations.set(source, (duration = resolve(source)));
      return duration;
    };
    const tracks: TimelineView["tracks"] = [];
    const problems: TimelineProblem[] = [];
    let duration: number | null = 0;
    for (const track of timeline.tracks) {
      const clips = [];
      if (track.kind !== "subtitles") {
        for (const clip of track.clips) {
          let end: number | null;
          try {
            end = await clipEnd(clip, grid, nested);
          } catch (error) {
            if (!(error instanceof NestedTimelineError)) throw error;
            end = null;
            const { message } = nestedClipError(error, { timeline: id, track: track.id, clip });
            problems.push({ clip: clip.id, track: track.id, source: error.chain[0]!, message });
          }
          duration = end === null || duration === null ? null : Math.max(duration, end);
          clips.push({ ...clip, end });
        }
      }
      tracks.push({
        id: track.id,
        kind: track.kind,
        name: track.name ?? null,
        follows: track.kind === "subtitles" ? track.follows : null,
        clips,
      });
    }
    return {
      timeline: id,
      path: timelineRel(id),
      revision: timeline.revision,
      fps,
      duration,
      tracks,
      problems,
    };
  }

  /** Track summaries in stacking order (`track.list`). */
  async tracks(
    root: string,
    id: string,
  ): Promise<{ timeline: string; revision: number; tracks: TrackSummary[]; problems: TimelineProblem[] }> {
    const view = await this.show(root, id);
    return {
      timeline: id,
      revision: view.revision,
      tracks: view.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        follows: track.follows,
        clips: track.clips.length,
        end: track.clips.reduce<number | null>((end, clip) => (end === null || clip.end === null ? null : Math.max(end, clip.end)), 0),
      })),
      problems: view.problems,
    };
  }

  #context(root: string, id: string, fps: number, op: string): EditContext {
    const grid = new FrameGrid(fps);
    const newId = this.#options.newId ?? ((prefix: "c" | "t") => `${prefix}_${randomBytes(3).toString("hex")}`);
    const resolveEditPoint = this.#options.resolveEditPoint?.(root);
    return {
      fps,
      source: async (asset) => {
        let probe: MediaProbe;
        try {
          probe = await this.#options.probe(root, asset);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          throw new RpcError(
            ErrorCode.InvalidOperation,
            `${asset} is not a media file ffprobe can read. Use a video, audio or image file.`,
            { op, reason: "unreadable media", field: "asset" },
          );
        }
        if (!probe.video && !probe.audio) {
          throw new RpcError(ErrorCode.InvalidOperation, `${asset} has no audio or video stream.`, {
            op,
            reason: "no streams",
            field: "asset",
          });
        }
        return {
          duration: probe.video?.still ? null : probe.duration,
          video: probe.video !== null,
          audio: probe.audio !== null,
        };
      },
      nestedDuration: this.#nestedDurations(root, [timelineRel(id)], grid),
      clipTypes: async () => {
        const adapters = await this.#options.clipTypes(root);
        return new Map([...adapters].map(([type, adapter]) => [type, clipTypeInfo(adapter)]));
      },
      newId,
      ...(resolveEditPoint ? { resolveEditPoint } : {}),
    };
  }

  /**
   * Duration of nested timeline files (project-relative). `stack` holds the
   * files being resolved, outermost first; meeting one again is a cycle.
   * Throws {@link NestedTimelineError} naming the chain down to the file
   * that is missing, invalid or cyclic.
   */
  #nestedDurations(root: string, stack: string[], grid: FrameGrid): (source: string) => Promise<number> {
    return async (source) => {
      const chain = [...stack.slice(1), source];
      if (stack.includes(source)) throw new NestedTimelineError("cycle", chain, [...stack, source].join(" -> "));
      let timeline: Timeline;
      try {
        timeline = await readTimelineFile(root, source);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        if (error.code === ErrorCode.TimelineNotFound) {
          throw new NestedTimelineError("missing", chain, "", await listTimelines(root));
        }
        if (error.code === ErrorCode.InvalidProjectFile) {
          throw new NestedTimelineError("invalid", chain, (error.data as { details: string }).details);
        }
        throw error;
      }
      return timelineDuration(timeline, grid, this.#nestedDurations(root, [...stack, source], grid));
    };
  }

  /** Parsed `timelines/<id>.json` and the project fps. Throws TimelineNotFound (listing the ids) or InvalidProjectFile. */
  async load(root: string, id: string): Promise<{ timeline: Timeline; fps: number }> {
    const project = await readEnclosingProject(root);
    const fps = project?.config.fps ?? 30;
    try {
      return { timeline: await readTimelineFile(root, timelineRel(id)), fps };
    } catch (error) {
      if (!(error instanceof RpcError && error.code === ErrorCode.TimelineNotFound)) throw error;
      const available = await listTimelines(root);
      throw new RpcError(
        ErrorCode.TimelineNotFound,
        `No timeline "${id}" (${timelineRel(id)}) in ${root}` + (available.length > 0 ? `; timelines: ${available.join(", ")}.` : "."),
        { timeline: id, path: timelineRel(id), available },
      );
    }
  }

  #exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return next;
  }
}

/** `timelines/<id>.json`. */
function timelineRel(id: string): string {
  return `timelines/${id}.json`;
}

function timelinePath(root: string, id: string): string {
  return join(root, "timelines", `${id}.json`);
}

async function listTimelines(root: string): Promise<string[]> {
  const names = await readdir(join(root, "timelines")).catch(() => []);
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
}

/** Parse a project-relative timeline file. Throws TimelineNotFound (missing) or InvalidProjectFile. */
async function readTimelineFile(root: string, rel: string): Promise<Timeline> {
  const path = join(root, ...rel.split("/"));
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new RpcError(ErrorCode.TimelineNotFound, `No timeline file ${rel}.`, { timeline: rel, path: rel, available: [] });
  }
  let parsed;
  try {
    parsed = parseTimeline(JSON.parse(text));
  } catch (error) {
    parsed = { ok: false as const, error: (error as Error).message };
  }
  if (!parsed.ok) {
    throw new RpcError(
      ErrorCode.InvalidProjectFile,
      `Invalid ${path}:\n${parsed.error}\nFix the file (or restore it from version control) and retry.`,
      { path, details: parsed.error },
    );
  }
  return parsed.value;
}

/**
 * Project-relative `asset`/`source` args, so the record and the file never
 * hold caller-specific paths. A relative path is tried against `cwd` first,
 * then the project root; a bare timeline id (`intro`) means `timelines/intro.json`.
 */
function normalizeArgs(call: TimelineCall): OperationRequest {
  const { request, root, cwd } = call;
  if (request.op !== "clip.add") return request;
  const args = { ...request.args };
  if (args.asset !== undefined) args.asset = projectPath(root, cwd, args.asset, "asset");
  if (args.source !== undefined) {
    const bareId = args.type === "timeline" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.source);
    args.source = bareId ? timelineRel(args.source) : projectPath(root, cwd, args.source, "source");
  }
  return { op: request.op, args };
}

function projectPath(root: string, cwd: string, path: string, field: string): string {
  const candidates = isAbsolute(path) ? [path] : [resolve(cwd, path), resolve(root, path)];
  const inside = candidates
    .map((candidate) => relative(root, candidate))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
  const chosen = inside.find((rel) => isFile(join(root, rel))) ?? inside[0];
  if (chosen === undefined || chosen.split(sep)[0]?.toLowerCase() === ".frameshell") {
    throw new RpcError(ErrorCode.InvalidOperation, `${field} ${path} is outside the project ${root}. Import it first: \`frameshell import <file>\`.`, {
      op: "clip.add",
      reason: "outside project",
      field,
    });
  }
  return chosen.split(sep).join("/");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Engine view of an adapter: Standard Schema props validation, or accept-all. */
function clipTypeInfo(adapter: ClipAdapter): ClipTypeInfo {
  return {
    validateProps: async (props) => {
      const schema = adapter.propsSchema;
      if (!schema) return null;
      const result = await schema["~standard"].validate(props);
      if (!result.issues) return null;
      return result.issues
        .map(({ message, path }) => {
          const where = (path ?? []).map((part) => String(typeof part === "object" ? part.key : part)).join(".");
          return where ? `${where}: ${message}` : message;
        })
        .join("; ");
    },
  };
}
