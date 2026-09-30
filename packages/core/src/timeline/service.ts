import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type HistoryResult,
  type JournalEntry,
  type MediaProbe,
  type OperationRecord,
  type OperationResult,
  RpcError,
  type TimelineProblem,
  type TimelineRejection as RejectionInfo,
  type TimelineView,
  type TrackSummary,
} from "@frameshell/protocol";
import type { ClipAdapter } from "@frameshell/plugin-api";
import { type ParseResult, type Timeline, parseTimeline } from "@frameshell/schema";
import { canonicalPath, exists, writeTextAtomic } from "../fs-util.js";
import { ToolError } from "../media/ffmpeg.js";
import { readEnclosingProject } from "../projects.js";
import { timelineHash } from "../history/hash.js";
import { appendJournal, readJournal } from "../history/journal.js";
import { type TimelineRevertFailure, abortConflictError, historyView, planRevert } from "../history/revert.js";
import { checkScriptRef } from "../scripts/outline.js";
import {
  type AppliedOperation,
  type ClipTypeInfo,
  type EditContext,
  type EditPointResolver,
  type OperationRequest,
  applyOperation,
} from "./engine.js";
import { FrameGrid } from "./grid.js";
import { diffTimelines } from "./patch.js";
import { NestedTimelineError, clipEnd, nestedClipError, timelineDuration } from "./timing.js";

/** Options for {@link TimelineService}. */
export interface TimelineServiceOptions {
  /** ffprobe summary of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Clip adapters loaded for the project; see `PluginHost.clipTypes`. */
  clipTypes(root: string): Promise<ReadonlyMap<string, ClipAdapter>>;
  /** Id generator. Default: prefix + 6 random hex digits (`c_1a2b3c`). */
  newId?: (prefix: "c" | "t") => string;
  /** Cut/trim edge adjustment per project and fps (#12 energy snapping). Default: none, edges stay. */
  resolveEditPoint?: (root: string, fps: number) => EditPointResolver | undefined;
  /**
   * Called after each applied operation (including `revert`) is written and
   * journaled, before the next operation on the same file starts: calls are in
   * revision order per timeline.
   */
  onChanged?: (change: TimelineChange) => void;
  /** Called after a direct edit is refused, the daemon's version restored and the edit preserved (SPEC §6.4). */
  onRejected?: (rejection: TimelineRejection) => void;
  /** Transaction of each accepted direct edit (author `file`). Default: a new one per edit. */
  fileTx?: () => TxRef;
}

/** A refused direct edit, as reported to {@link TimelineServiceOptions.onRejected} and {@link TimelineService.rejections}. */
export interface TimelineRejection extends RejectionInfo {
  /** Project root, canonical (`canonicalPath`): one spelling however callers named the project. */
  root: string;
}

/** One applied operation, as reported to {@link TimelineServiceOptions.onChanged}. */
export interface TimelineChange {
  /** Project root, canonical (`canonicalPath`): one spelling however callers named the project. */
  root: string;
  /** Timeline id. */
  timeline: string;
  /** Revision after the operation. */
  revision: number;
  /** SPEC §6.2 author. */
  author: string;
  changes: OperationResult["changes"];
}

/** Transaction an operation joins (SPEC §6.2). */
export interface TxRef {
  /** `tx_` + 8 hex digits. */
  id: string;
  /** Label from `tx.begin`; null for automatic grouping. */
  label: string | null;
}

/** Who asks, where, and in which transaction; shared by {@link TimelineCall} and {@link RevertCall}. */
export interface CallContext {
  /** Project root. */
  root: string;
  /** Caller's directory: relative `asset`/`source` args resolve against it first. */
  cwd: string;
  /** Timeline id (`timelines/<id>.json`). */
  timeline: string;
  /** SPEC §6.2 author: `ui`, `cli:<session>`, `cli`, `file`, `plugin:<name>`. */
  author: string;
  tx: TxRef;
}

/** Operation to run: the engine request plus who asked. */
export interface TimelineCall extends CallContext {
  request: OperationRequest;
}

/** Revert to run: a tx id (`tx_…`) or op id (`op_…`) from the timeline's journal. */
export interface RevertCall extends CallContext {
  target: string;
}

/** Transaction undo across timelines; see {@link TimelineService.revertAll}. */
export interface RevertAllCall {
  /** SPEC §6.2 author of the `revert` operations. */
  author: string;
  /** Transaction the `revert` operations join. */
  tx: TxRef;
  /** Transaction id to undo. */
  target: string;
  /** Timelines it changed, in the order to revert and report them. */
  timelines: { root: string; timeline: string }[];
}

/** Rejections kept per project for `status`, newest first. */
const MAX_REJECTIONS = 20;

/**
 * Last content the daemon wrote, accepted or first read for one timeline
 * file. `timeline` null: the file was invalid when first seen, so there is
 * no version to restore.
 */
interface Known {
  text: string;
  timeline: Timeline | null;
}

/**
 * The daemon's timeline files (SPEC §6.1): loads a timeline, runs one
 * operation through the engine with project facts (fps, media probes,
 * nested timelines, plugin clip types), writes the result atomically and
 * returns the operation record. Operations on one file are serialized.
 *
 * Direct edits (SPEC §6.4): every read compares the file with the last
 * content this service wrote or accepted. A difference is someone else's
 * edit: with the current `revision` and valid content it is journaled as a
 * `timeline.patch` operation by author `file`; otherwise the daemon's version
 * is restored and the edit kept under `.frameshell/rejected/`. The service's
 * own writes match what it remembers, so they never count as edits.
 */
export class TimelineService {
  readonly #options: TimelineServiceOptions;
  readonly #queues = new Map<string, Promise<unknown>>();
  /** By {@link TimelineService.#key}. */
  readonly #known = new Map<string, Known>();
  /** By real project root, newest first. */
  readonly #rejections = new Map<string, TimelineRejection[]>();
  /** Real path of each project root seen. */
  readonly #realRoots = new Map<string, Promise<string>>();

  constructor(options: TimelineServiceOptions) {
    this.#options = options;
  }

  /**
   * Apply one operation, write the file, then append it to the journal
   * (SPEC §6.1). Throws the engine's errors, TimelineNotFound or InvalidProjectFile.
   */
  async apply(call: TimelineCall): Promise<OperationResult> {
    const { root, timeline: id, request: raw } = call;
    // Soft check (SPEC §5.5): the script may be written after the clip is placed. Runs before
    // the queue and the write: it never throws, and a slow script read never holds the timeline.
    const scriptRef = raw.op === "clip.add" || raw.op === "clip.set" ? raw.args.scriptRef : undefined;
    const problem = typeof scriptRef === "string" ? await checkScriptRef(root, scriptRef) : null;
    const warnings = problem ? [problem] : [];
    return this.#turn(root, id, async () => {
      const { timeline, fps, snapWindow } = await this.#current(root, id);
      const request = normalizeArgs(call);
      const context = this.#context(root, id, fps, request.op, snapWindow);
      return this.#record(call, timeline, await applyOperation(timeline, request, context), request.op, request.args, warnings);
    });
  }

  /**
   * Undo a transaction or one operation (SPEC §6.2): apply the stored inverses
   * newest first, as one new journaled `revert` operation. Throws
   * HistoryNotFound, RevertConflict (see `planRevert`) or the engine's errors.
   */
  revert(call: RevertCall): Promise<OperationResult> {
    const { root, timeline: id, target } = call;
    return this.#turn(root, id, async () => {
      const { timeline, fps } = await this.#current(root, id);
      const restored = planRevert(timeline, await readJournal(root, id), target, id);
      const patch = { op: "timeline.patch" as const, args: diffTimelines(timeline, restored) };
      const applied = await applyOperation(timeline, patch, this.#context(root, id, fps, "revert"));
      return this.#record(call, timeline, applied, "revert", { target });
    });
  }

  /**
   * Undo transaction `call.target` on every timeline in `call.timelines`, all
   * or nothing (SPEC §6.2 `tx.abort`): every timeline is locked and planned
   * first, and only when none conflicts is each written, as one journaled
   * `revert` per timeline in `call.tx`. Timelines whose journal holds no
   * operation of the target (an operation that failed) are skipped. Throws
   * RevertConflict listing every conflicting timeline, with nothing undone;
   * other errors (TimelineNotFound, engine errors) also before any write.
   */
  async revertAll(call: RevertAllCall): Promise<OperationResult[]> {
    const { timelines, target } = call;
    const keys = await Promise.all(timelines.map(({ root, timeline }) => this.#key(root, timeline)));
    return this.#exclusive(
      keys,
      async () => {
        const planned: { where: { root: string; timeline: string }; before: Timeline; applied: AppliedOperation }[] = [];
        const failures: TimelineRevertFailure[] = [];
        for (const where of timelines) {
          const { root, timeline: id } = where;
          const entries = await readJournal(root, id);
          if (!entries.some((entry) => entry.tx === target)) continue;
          const { timeline, fps } = await this.#current(root, id);
          let restored: Timeline;
          try {
            restored = planRevert(timeline, entries, target, id);
          } catch (error) {
            if (!(error instanceof RpcError && error.code === ErrorCode.RevertConflict)) throw error;
            failures.push({ root, timeline: id, error });
            continue;
          }
          const patch = { op: "timeline.patch" as const, args: diffTimelines(timeline, restored) };
          planned.push({ where, before: timeline, applied: await applyOperation(timeline, patch, this.#context(root, id, fps, "revert")) });
        }
        if (failures.length > 0) throw abortConflictError(target, failures);
        const results: OperationResult[] = [];
        for (const { where, before, applied } of planned) {
          const context = { root: where.root, cwd: where.root, timeline: where.timeline, author: call.author, tx: call.tx };
          results.push(await this.#record(context, before, applied, "revert", { target }));
        }
        return results;
      },
    );
  }

  /**
   * Take in whatever is on disk for timeline `id` now (the daemon's watcher
   * calls this on every change): a direct edit is journaled or rejected (see
   * the class doc); the service's own writes are no-ops. Throws
   * TimelineNotFound when the file is gone, InvalidProjectFile when it is
   * invalid and there is no earlier version to restore.
   */
  async reconcile(root: string, id: string): Promise<void> {
    await this.load(root, id);
  }

  /**
   * `file.write` of `timelines/<id>.json` (SPEC §6.4): `content` is taken in
   * like a direct edit, but a refusal throws instead of touching the disk:
   * InvalidProjectFile (not JSON or schema), StaleRevision (`revision` is
   * not the current one) or the engine's errors (timeline rules). Without a
   * readable current version (new or broken file), valid content is written as is.
   */
  writeFile(root: string, id: string, content: string): Promise<void> {
    return this.#turn(root, id, async () => {
      const path = timelinePath(root, id);
      let base: Timeline | null = null;
      try {
        base = (await this.#current(root, id)).timeline;
      } catch (error) {
        const code = error instanceof RpcError ? error.code : undefined;
        if (code !== ErrorCode.TimelineNotFound && code !== ErrorCode.InvalidProjectFile) throw error;
      }
      if (base) {
        await this.#acceptEdit(root, id, content, base, await projectFps(root));
        return;
      }
      const parsed = parseText(content);
      if (!parsed.ok) throw invalidFile(path, parsed.error);
      await writeTextAtomic(path, content);
      const key = await this.#key(root, id);
      const replaced = this.#known.has(key);
      this.#known.set(key, { text: content, timeline: parsed.value });
      if (replaced) await this.#announce(root, id, parsed.value);
    });
  }

  /** Direct edits of `root`'s timelines refused since the daemon started, newest first (`status`). */
  async rejections(root: string): Promise<TimelineRejection[]> {
    return [...(this.#rejections.get(await this.#realRoot(root)) ?? [])];
  }

  /** Journaled operations grouped by transaction; see `historyView`. Throws HistoryNotFound for an unknown `since`. */
  async history(root: string, id: string, options: { since?: string | undefined }): Promise<HistoryResult> {
    await this.load(root, id); // TimelineNotFound for a typo, not an empty history.
    return historyView(await readJournal(root, id), id, options.since);
  }

  /**
   * Write the applied result, then journal it with the content hashes before
   * and after. If the append fails the file is ahead of the journal; the
   * hash chain shows that gap and `revert` refuses to cross it.
   */
  async #record(
    call: CallContext,
    before: Timeline,
    applied: AppliedOperation,
    op: string,
    args: unknown,
    warnings: string[] = [],
  ): Promise<OperationResult> {
    const { root, timeline: id } = call;
    const path = timelinePath(root, id);
    const text = `${JSON.stringify(applied.timeline, null, 2)}\n`;
    await writeTextAtomic(path, text);
    this.#known.set(await this.#key(root, id), { text, timeline: applied.timeline });
    const operation: OperationRecord = {
      id: `op_${randomBytes(4).toString("hex")}`,
      op,
      args: args as Record<string, unknown>,
      inverse: applied.inverse,
      author: call.author,
      tx: call.tx.id,
      revisionBefore: before.revision,
    };
    const entry: JournalEntry = {
      ...operation,
      txLabel: call.tx.label,
      at: new Date().toISOString(),
      revision: applied.timeline.revision,
      hashBefore: timelineHash(before),
      hash: timelineHash(applied.timeline),
    };
    await appendJournal(root, id, entry);
    this.#options.onChanged?.({
      root: await this.#realRoot(root),
      timeline: id,
      revision: applied.timeline.revision,
      author: call.author,
      changes: applied.changes,
    });
    return { timeline: id, revision: applied.timeline.revision, operation, changes: applied.changes, snaps: applied.snaps, warnings };
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

  #context(root: string, id: string, fps: number, op: string, snapWindow?: number): EditContext {
    const grid = new FrameGrid(fps);
    const newId = this.#options.newId ?? ((prefix: "c" | "t") => `${prefix}_${randomBytes(3).toString("hex")}`);
    const resolveEditPoint = this.#options.resolveEditPoint?.(root, fps);
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
      ...(snapWindow !== undefined ? { snapWindow } : {}),
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

  /**
   * Parsed `timelines/<id>.json` and the project fps, after taking in any
   * direct edit (see {@link TimelineService.reconcile}). Throws
   * TimelineNotFound (listing the ids) or InvalidProjectFile.
   */
  load(root: string, id: string): Promise<{ timeline: Timeline; fps: number; snapWindow?: number }> {
    return this.#turn(root, id, () => this.#current(root, id));
  }

  /** {@link TimelineService.load} for callers already holding the file's turn. */
  async #current(root: string, id: string): Promise<{ timeline: Timeline; fps: number; snapWindow?: number }> {
    const project = await readEnclosingProject(root);
    const fps = project?.config.fps ?? 30;
    const window = project?.config.editing?.snapWindow;
    const snap = window !== undefined ? { snapWindow: window } : {};
    const path = timelinePath(root, id);
    const key = await this.#key(root, id);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#known.delete(key);
      const available = await listTimelines(root);
      throw new RpcError(
        ErrorCode.TimelineNotFound,
        `No timeline "${id}" (${timelineRel(id)}) in ${root}` + (available.length > 0 ? `; timelines: ${available.join(", ")}.` : "."),
        { timeline: id, path: timelineRel(id), available },
      );
    }
    const known = this.#known.get(key);
    if (known?.timeline && known.text === text) return { timeline: structuredClone(known.timeline), fps, ...snap };
    if (known?.timeline) return { timeline: await this.#absorb(root, id, text, known.timeline, fps), fps, ...snap };
    // First sight, or no valid version yet: nothing to diff against or restore.
    const parsed = parseText(text);
    this.#known.set(key, { text, timeline: parsed.ok ? parsed.value : null });
    if (!parsed.ok) throw invalidFile(path, parsed.error);
    if (known) await this.#announce(root, id, parsed.value);
    return { timeline: structuredClone(parsed.value), fps, ...snap };
  }

  /** A direct edit on disk: journal it, or restore `base` and keep the edit. Returns the timeline now on disk. */
  async #absorb(root: string, id: string, text: string, base: Timeline, fps: number): Promise<Timeline> {
    try {
      return await this.#acceptEdit(root, id, text, base, fps);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      const reason = error.code === ErrorCode.StaleRevision ? "stale" : "invalid";
      await this.#reject(root, id, text, base, reason, error.message);
      return structuredClone(base);
    }
  }

  /**
   * Journal `text` as one `timeline.patch` operation by author `file` on top
   * of `base`, bumping the revision. Throws, without writing: InvalidProjectFile,
   * StaleRevision, or the engine's errors for a patch breaking timeline rules.
   */
  async #acceptEdit(root: string, id: string, text: string, base: Timeline, fps: number): Promise<Timeline> {
    const path = timelinePath(root, id);
    const parsed = parseText(text);
    if (!parsed.ok) throw invalidFile(path, parsed.error);
    const incoming = parsed.value;
    if (incoming.revision !== base.revision) {
      throw new RpcError(
        ErrorCode.StaleRevision,
        `${timelineRel(id)} was edited at revision ${incoming.revision}, but timeline ${id} is at revision ${base.revision}` +
          `${incoming.revision < base.revision ? " (it changed since that copy was read)" : ""}. ` +
          "Re-read the file, reapply the edit keeping its `revision`, and save again.",
        { path, timeline: id, revision: incoming.revision, current: base.revision },
      );
    }
    const patch = diffTimelines(base, incoming);
    if (!patch.tracks && !patch.clips && !patch.order) {
      // Same tracks and clips (formatting, key order): nothing to journal.
      await writeTextAtomic(path, text);
      this.#known.set(await this.#key(root, id), { text, timeline: base });
      return structuredClone(base);
    }
    const applied = await applyOperation(base, { op: "timeline.patch", args: patch }, this.#context(root, id, fps, "timeline.patch"));
    const tx = this.#options.fileTx?.() ?? { id: `tx_${randomBytes(4).toString("hex")}`, label: null };
    await this.#record({ root, cwd: root, timeline: id, author: "file", tx }, base, applied, "timeline.patch", patch);
    return applied.timeline;
  }

  /** Restore `base` on disk, keep `text` under `.frameshell/rejected/`, report it (SPEC §6.4). */
  async #reject(root: string, id: string, text: string, base: Timeline, reason: "stale" | "invalid", message: string): Promise<void> {
    const at = new Date().toISOString();
    const stamp = at.replace(/[:.]/g, "-"); // `:` is not allowed in Windows file names.
    let preserved = `.frameshell/rejected/${stamp}-${id}.json`;
    for (let n = 2; await exists(join(root, preserved)); n++) preserved = `.frameshell/rejected/${stamp}-${n}-${id}.json`;
    await writeTextAtomic(join(root, preserved), text);
    const path = timelinePath(root, id);
    const key = await this.#key(root, id);
    const restored = this.#known.get(key)?.text ?? `${JSON.stringify(base, null, 2)}\n`;
    await writeTextAtomic(path, restored);
    this.#known.set(key, { text: restored, timeline: base });
    const real = await this.#realRoot(root);
    const rejection: TimelineRejection = {
      root: real,
      timeline: id,
      reason,
      message,
      preserved,
      revision: revisionOf(text),
      current: base.revision,
      at,
    };
    this.#rejections.set(real, [rejection, ...(this.#rejections.get(real) ?? [])].slice(0, MAX_REJECTIONS));
    this.#options.onRejected?.(rejection);
  }

  /** A timeline that became readable without an operation (new or repaired file): re-read all of it. */
  async #announce(root: string, id: string, timeline: Timeline): Promise<void> {
    const updated = timeline.tracks.map((track) => track.id);
    this.#options.onChanged?.({
      root: await this.#realRoot(root),
      timeline: id,
      revision: timeline.revision,
      author: "file",
      changes: { added: [], updated, removed: [], range: { from: 0, to: null } },
    });
  }

  /**
   * Identity of a timeline file across spellings of its root (symlinks,
   * `/var` vs `/private/var`): the app, the CLI and the watcher may name one
   * project differently, and must share one known version and one queue.
   */
  async #key(root: string, id: string): Promise<string> {
    return timelinePath(await this.#realRoot(root), id);
  }

  #realRoot(root: string): Promise<string> {
    let real = this.#realRoots.get(root);
    if (!real) this.#realRoots.set(root, (real = canonicalPath(root)));
    return real;
  }

  /** Run `work` after every earlier call on the same timeline file. */
  async #turn<T>(root: string, id: string, work: () => Promise<T>): Promise<T> {
    return this.#exclusive([await this.#key(root, id)], work);
  }

  /** Run `work` once every earlier task on any of `keys` settled, holding all of them. Queues are claimed synchronously, so no deadlock. */
  #exclusive<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const previous = Promise.all(unique.map((key) => this.#queues.get(key) ?? Promise.resolve()));
    const next = previous.then(work);
    const settled = next.catch(() => {});
    for (const key of unique) this.#queues.set(key, settled);
    void settled.then(() => {
      for (const key of unique) if (this.#queues.get(key) === settled) this.#queues.delete(key);
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

async function projectFps(root: string): Promise<number> {
  return (await readEnclosingProject(root))?.config.fps ?? 30;
}

/** Timeline file content, JSON syntax and schema checked. */
function parseText(text: string): ParseResult<Timeline> {
  try {
    return parseTimeline(JSON.parse(text));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function invalidFile(path: string, details: string): RpcError {
  return new RpcError(
    ErrorCode.InvalidProjectFile,
    `Invalid ${path}:\n${details}\nFix the file (or restore it from version control) and retry.`,
    { path, details },
  );
}

/** `revision` of unvalidated content, when it has a readable one. */
function revisionOf(text: string): number | null {
  try {
    const revision = (JSON.parse(text) as { revision?: unknown } | null)?.revision;
    return Number.isInteger(revision) ? (revision as number) : null;
  } catch {
    return null;
  }
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
  const parsed = parseText(text);
  if (!parsed.ok) throw invalidFile(path, parsed.error);
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
