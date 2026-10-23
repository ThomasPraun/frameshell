import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type ClipPlace,
  type HistoryDiffResult,
  type HistoryResult,
  type JournalEntry,
  type MediaProbe,
  type OperationRecord,
  type OperationResult,
  type GcEntry,
  type Proposal,
  type ProposalDecision,
  type ProposalOutcome,
  type ProposalState,
  type ProposalWaitResult,
  type RejectionRecord,
  type ReviewState,
  type TimelinePatch,
  RpcError,
  type TimelineProblem,
  type TimelineRejection as RejectionInfo,
  type TimelineView,
  type TimelineViewName,
  type TrackSummary,
} from "@frameshell/protocol";
import type { ClipAdapter } from "@frameshell/plugin-api";
import { type ParseResult, type Timeline, parseTimeline } from "@frameshell/schema";
import { canonicalPath, exists, writeTextAtomic } from "../fs-util.js";
import { ToolError } from "../media/ffmpeg.js";
import { readEnclosingProject } from "../projects.js";
import { timelineHash } from "../history/hash.js";
import { type ClipChange, type PlacedClip, planDiff } from "../history/diff.js";
import { appendJournal, readHead, readJournal, writeHead } from "../history/journal.js";
import {
  type TimelineRevertFailure,
  abortConflictError,
  historyView,
  overlappingIds,
  planRevert,
  touchedIds,
} from "../history/revert.js";
import {
  type OpenProposal,
  type ProposalPart,
  type ProposedFile,
  type ProposedOp,
  appendDecision,
  loadOpenProposals,
  readDecisions,
  removeProposal,
  saveProposal,
  sweepProposals,
} from "../proposals/store.js";
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
import { applyPatch, diffTimelines, isEmptyPatch } from "./patch.js";
import { listRejections, recordRejection, revisionOf } from "./rejections.js";
import { NestedTimelineError, clipEnd, nestedClipError, timelineDuration } from "./timing.js";

/** Project settings an operation's {@link EditContext} takes from `frameshell.json`. */
type EditSettings = Pick<EditContext, "snapWindow" | "defaultStillDuration">;

/** Options for {@link TimelineService}. */
export interface TimelineServiceOptions {
  /** ffprobe summary of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Clip adapters loaded for the project; see `PluginHost.clipTypes`. */
  clipTypes(root: string): Promise<ReadonlyMap<string, ClipAdapter>>;
  /** Id generator. Default: prefix + 6 random hex digits (`c_1a2b3c`). */
  newId?: (prefix: "c" | "t" | "g") => string;
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
  /** Review mode switch of a canonical project root (ADR 0019). Default: off everywhere. */
  reviewEnabled?: (root: string) => Promise<boolean>;
  /** Whether transaction `tx` is still open, so a proposal restored after a restart knows it is still building. Default: closed. */
  txOpen?: (tx: string) => boolean;
  /** Called on every step of a review-mode proposal; see {@link ProposalChange}. */
  onProposal?: (change: ProposalChange) => void;
}

/** One step of a proposal (ADR 0019), as reported to {@link TimelineServiceOptions.onProposal}. */
export interface ProposalChange {
  /** Project root, canonical (`canonicalPath`). */
  root: string;
  tx: string;
  label: string | null;
  author: string;
  state: ProposalState;
  operations: number;
  timelines: string[];
  conflicts: string[];
  /** It closed unapplied while its transaction was still open: the caller ends that transaction. */
  endsTx: boolean;
}

/** Review mode state of one project; see {@link TimelineService.#book}. */
interface Book {
  /** Project root, canonical. */
  root: string;
  proposal: OpenProposal | null;
  /** Set while a new proposal's first operation runs: other authors wait for it before deciding. */
  creating: Promise<void> | null;
  /** Per journal author whose building proposal closed unapplied: told once, on their next change. */
  notices: Map<string, { tx: string; reason: "stale" | "rejected"; conflicts: string[] }>;
  /** `proposal.wait` calls, resolved when the open proposal closes. */
  waiters: Set<(decision: ProposalDecision) => void>;
  /** Proposal file writes, one at a time, each writing the state current when it starts. */
  saving: Promise<void>;
  /** Set while a closed proposal's decision is being logged. */
  closing: Promise<void> | null;
}

/** Where a change by a non-`ui` author goes while review mode applies; see {@link TimelineService.#route}. */
interface Route {
  book: Book;
  proposal: OpenProposal;
  /** `proposal` is new: it joins the book once its first operation succeeds. */
  created: boolean;
  /** Let other authors decide again; call once the operation settled. */
  release(): void;
}

/** What a proposed change computed on the proposal's version of a timeline. */
interface Proposed {
  applied: AppliedOperation;
  op: string;
  args: Record<string, unknown>;
  warnings?: string[];
}

/** A timeline as a read with `view` shows it; see {@link TimelineService.viewTimeline}. */
export interface Viewed {
  timeline: Timeline;
  fps: number;
  view: TimelineViewName;
  /** The project's open proposal; null when none. */
  proposal: { tx: string; state: "building" | "ready" } | null;
}

/**
 * What goes back on disk after a refused or proposed direct edit: the daemon's
 * version, or for a file it has none of, the earlier unreadable text (null: no
 * file, it is removed).
 */
type Restore = Timeline | { unread: string | null };

/** Decisions `status` and `proposal.status` list. */
const MAX_DECISIONS = 10;

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

/** Who saves a timeline through {@link TimelineService.writeFile}, and in which transaction. */
export interface Saver {
  /** SPEC §6.2 author, e.g. `ui` for the desktop editor. */
  author: string;
  tx: TxRef;
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
  /** Called with the timeline this operation wrote, before the next operation can run on it. */
  onApplied?: (timeline: Timeline) => void;
  /**
   * Called in the operation's turn with the timeline it applies to, before the engine runs:
   * returns the request to apply instead of `request`, for args that must match that timeline.
   */
  prepare?: (timeline: Timeline) => Promise<OperationRequest>;
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

/** Rejections listed by `status`, newest first. */
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
  /** Real path of each project root seen. */
  readonly #realRoots = new Map<string, Promise<string>>();
  /** Review mode state by canonical root, loaded on first use. */
  readonly #books = new Map<string, Promise<Book>>();
  /** {@link TimelineService.#books} already loaded. */
  readonly #loaded = new Map<string, Book>();
  /**
   * Timeline ids on disk when each canonical root was first read, minus ids seen
   * missing since: a file outside it that the daemon never wrote is new (ADR 0019 §9).
   */
  readonly #baselines = new Map<string, Promise<Set<string>>>();

  constructor(options: TimelineServiceOptions) {
    this.#options = options;
  }

  /**
   * Apply one operation, write the file, then append it to the journal
   * (SPEC §6.1). In review mode (ADR 0019) a non-`ui` author's operation
   * joins the open proposal instead. Throws the engine's errors,
   * TimelineNotFound, InvalidProjectFile, ProposalPending or ProposalState.
   */
  async apply(call: TimelineCall): Promise<OperationResult> {
    const { root, timeline: id, request: raw } = call;
    // Soft check (SPEC §5.5): the script may be written after the clip is placed. Runs before
    // the queue and the write: it never throws, and a slow script read never holds the timeline.
    const scriptRef = raw.op === "clip.add" || raw.op === "clip.set" ? raw.args.scriptRef : undefined;
    const problem = typeof scriptRef === "string" ? await checkScriptRef(root, scriptRef) : null;
    const warnings = problem ? [problem] : [];
    return this.#turn(root, id, async () => {
      const route = await this.#route(root, call.author, call.tx);
      if (route) {
        try {
          const result = await this.#propose(root, id, route, call, async (base, _current, fps, settings) => {
            const request = normalizeArgs(call.prepare ? { ...call, request: await call.prepare(base) } : call);
            const applied = await applyOperation(base, request, this.#context(root, id, fps, request.op, settings));
            return { applied, op: request.op, args: request.args as Record<string, unknown>, warnings };
          });
          call.onApplied?.(result!.shadow);
          return result!.result;
        } finally {
          route.release();
        }
      }
      const { timeline, fps, ...settings } = await this.#current(root, id);
      const request = normalizeArgs(call.prepare ? { ...call, request: await call.prepare(timeline) } : call);
      const context = this.#context(root, id, fps, request.op, settings);
      const applied = await applyOperation(timeline, request, context);
      const result = await this.#record(call, timeline, applied, request.op, request.args, warnings);
      call.onApplied?.(applied.timeline);
      return result;
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
      const route = await this.#route(root, call.author, call.tx);
      if (route) {
        try {
          // Undo is planned on the file's journal; the proposal holds its effect.
          const proposed = await this.#propose(root, id, route, call, async (base, current, fps) => {
            const restored = planRevert(current, await readJournal(root, id), target, id);
            const patch = { op: "timeline.patch" as const, args: diffTimelines(current, restored) };
            return { applied: await applyOperation(base, patch, this.#context(root, id, fps, "revert")), op: "revert", args: { target } };
          });
          return proposed!.result;
        } finally {
          route.release();
        }
      }
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
   * other errors (TimelineNotFound, engine errors, ProposalPending) also
   * before any write. In review mode (ADR 0019) a project's undo is not
   * written: it waits as one ready proposal in a new transaction, `proposal`.
   */
  async revertAll(call: RevertAllCall): Promise<{ reverted: OperationResult[]; proposal: { tx: string; state: "ready" } | null }> {
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
        // ADR 0019: undoing what reached the file is a change too; in review mode it waits as a ready proposal of its own.
        const undo: TxRef = { id: newTxId(), label: `Abort "${call.tx.label ?? target}"` };
        const routes = new Map<string, Route | null>();
        try {
          for (const { where } of planned) {
            const real = await this.#realRoot(where.root);
            if (!routes.has(real)) routes.set(real, await this.#route(where.root, call.author, undo));
          }
          const at = new Date().toISOString();
          const direct: typeof planned = [];
          for (const step of planned) {
            const route = routes.get(await this.#realRoot(step.where.root));
            if (!route) {
              direct.push(step);
              continue;
            }
            const { before, applied } = step;
            const patch = diffTimelines(before, applied.timeline);
            const op: ProposedOp = { id: newOpId(), op: "revert", args: { target }, patch, inverse: applied.inverse, at };
            route.proposal.parts.push({ timeline: step.where.timeline, base: before, shadow: applied.timeline, ops: [op] });
          }
          let proposal: { tx: string; state: "ready" } | null = null;
          for (const route of routes.values()) {
            if (!route) continue;
            route.proposal.state = "ready";
            route.book.proposal = route.proposal;
            try {
              await this.#persist(route.book);
            } catch (error) {
              route.book.proposal = null;
              throw error;
            }
            this.#emit(route.book, route.proposal, "ready");
            proposal = { tx: undo.id, state: "ready" };
          }
          const reverted: OperationResult[] = [];
          for (const { where, before, applied } of direct) {
            const context = { root: where.root, cwd: where.root, timeline: where.timeline, author: call.author, tx: call.tx };
            reverted.push(await this.#record(context, before, applied, "revert", { target }));
          }
          return { reverted, proposal };
        } finally {
          for (const route of routes.values()) route?.release();
        }
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
   * like a direct edit, journaled by `saver` (default: author `file`), but a
   * refusal throws instead of touching the disk: InvalidProjectFile (not
   * JSON or schema), StaleRevision (`revision` is not the current one) or
   * the engine's errors (timeline rules). Without a readable current version
   * (new or broken file), valid content is written as is; in review mode
   * (ADR 0019) it is kept with the proposal instead, out of `timelines/`.
   * Returns the journaled operation; null when nothing was journaled.
   */
  writeFile(root: string, id: string, content: string, saver?: Saver): Promise<OperationResult | null> {
    return this.#turn(root, id, async () => {
      const path = timelinePath(root, id);
      let base: Timeline | null = null;
      try {
        base = (await this.#current(root, id)).timeline;
      } catch (error) {
        if (!unreadable(error)) throw error;
      }
      if (base) {
        const who = saver ?? this.#fileSaver();
        const route = await this.#route(root, who.author, who.tx);
        if (route) {
          try {
            const proposed = await this.#propose(root, id, route, who, async (shadow, _current, fps) => {
              const incoming = checkRevision(id, path, parseIncoming(path, content), shadow);
              const patch = diffTimelines(shadow, incoming);
              if (isEmptyPatch(patch)) return null;
              const applied = await applyOperation(shadow, { op: "timeline.patch", args: patch }, this.#context(root, id, fps, "timeline.patch"));
              return { applied, op: "timeline.patch", args: patch as Record<string, unknown> };
            });
            return proposed?.result ?? null;
          } finally {
            route.release();
          }
        }
        return (await this.#acceptEdit(root, id, content, base, await projectFps(root), who)).result;
      }
      const parsed = parseText(content);
      if (!parsed.ok) throw invalidFile(path, parsed.error);
      const who = saver ?? this.#fileSaver();
      const route = await this.#route(root, who.author, who.tx);
      if (route) {
        try {
          await this.#proposeFile(id, route, content);
          return null;
        } finally {
          route.release();
        }
      }
      let result: OperationResult | null = null;
      const journaled = await this.#journaledBase(root, id, content, parsed.value);
      if (journaled) {
        const patch = diffTimelines(journaled, parsed.value);
        const extended = await this.#extend(root, id, journaled, patch, await projectFps(root), who);
        result = extended.result;
        if (!result) await this.#announce(root, id, extended.timeline);
      } else {
        await this.#install(root, id, content, parsed.value);
      }
      // ADR 0019 §7: the person wrote a timeline the open proposal adds.
      const book = await this.#book(root);
      if (book.proposal && proposedFile(book.proposal, id)) await this.#close(book, book.proposal, "stale", [id]);
      return result;
    });
  }

  /** Write `content` (parsed: `timeline`) as timeline `id` with no journal entry: a new or repaired file. */
  async #install(root: string, id: string, content: string, timeline: Timeline): Promise<void> {
    await writeTextAtomic(timelinePath(root, id), content);
    const key = await this.#key(root, id);
    const replaced = this.#known.has(key);
    this.#known.set(key, { text: content, timeline });
    if (replaced) await this.#announce(root, id, timeline);
  }

  /**
   * Keep `text`, new timeline `id` or one replacing an unreadable file, in the
   * proposal of `route` instead of `timelines/`; the author writing it again
   * replaces it. Saved before this returns. Caller holds the turn.
   */
  async #proposeFile(id: string, route: Route, text: string): Promise<void> {
    const { book, proposal } = route;
    const previous = proposal.files;
    proposal.files = [...(previous ?? []).filter((file) => file.timeline !== id), { timeline: id, text }];
    if (route.created) book.proposal = proposal;
    try {
      await this.#persist(book);
    } catch (error) {
      proposal.files = previous;
      if (route.created) book.proposal = null;
      throw error;
    }
    this.#emit(book, proposal, proposal.state);
  }

  /**
   * Refused direct edits of `root`'s timelines whose preserved copy is still
   * on disk, newest first, at most 20 (`status`). Read from disk, so they
   * survive restarts; see `listRejections`.
   */
  rejections(root: string): Promise<RejectionRecord[]> {
    return listRejections(root, MAX_REJECTIONS);
  }

  /**
   * Journaled operations grouped by transaction (see `historyView`), plus the
   * decided proposals of this timeline (ADR 0019). `since` may also name a
   * proposal that never reached the journal (rejected, stale): then what was
   * journaled after its decision. Throws HistoryNotFound for an unknown `since`.
   */
  async history(root: string, id: string, options: { since?: string | undefined }): Promise<HistoryResult> {
    await this.load(root, id); // TimelineNotFound for a typo, not an empty history.
    const entries = await readJournal(root, id);
    const decisions = (await readDecisions(await this.#realRoot(root))).filter((decision) => decision.timelines.includes(id));
    const { since } = options;
    if (since !== undefined && !entries.some((entry) => entry.tx === since)) {
      const decided = decisions.findLastIndex((decision) => decision.tx === since);
      if (decided !== -1) {
        const after = decisions[decided]!.at;
        const view = historyView(entries.filter((entry) => entry.at > after), id);
        return { ...view, since, proposals: decisions.slice(decided) };
      }
    }
    const view = historyView(entries, id, since);
    if (since === undefined) return { ...view, proposals: decisions };
    const from = entries.findLast((entry) => entry.tx === since)!.at;
    return { ...view, proposals: decisions.filter((decision) => decision.tx === since || decision.at >= from) };
  }

  /** What a transaction or operation did to clips (`history.diff`); see `planDiff`. Ends are derived like `show`'s. */
  diff(root: string, id: string, target: string): Promise<HistoryDiffResult> {
    return this.#turn(root, id, async () => {
      const { timeline, fps } = await this.#current(root, id);
      return this.#placeDiff(root, id, fps, target, planDiff(timeline, await readJournal(root, id), target, id));
    });
  }

  /**
   * What the open proposal (or `tx`, when it is the open one) changes on each
   * timeline, from the file to the proposal's version (`proposal.diff`), in
   * the shape of `history.diff`: the proposal's operations are diffed like a
   * journaled transaction. Empty without an open proposal and `tx`; throws
   * ProposalState (`decided`, `unknown`) for a `tx` that is not open.
   */
  async proposalDiff(root: string, tx?: string): Promise<{ tx: string | null; timelines: HistoryDiffResult[] }> {
    const book = await this.#book(root);
    const proposal = tx === undefined ? book.proposal : await this.#decidable(book.root, book, tx);
    if (!proposal) return { tx: null, timelines: [] };
    const timelines: HistoryDiffResult[] = [];
    for (const id of proposal.parts.map((part) => part.timeline)) {
      const diff = await this.#turn(root, id, async () => {
        const { timeline: current, fps } = await this.#current(root, id);
        if (!(await this.#sync(root, id, book, current, fps))) return null;
        const part = proposal.parts.find((candidate) => candidate.timeline === id)!;
        const { state, entries } = proposedEntries(part, proposal);
        return this.#placeDiff(root, id, fps, proposal.tx, planDiff(state, entries, proposal.tx, id));
      });
      if (!diff) return this.proposalDiff(root, tx); // Went stale meanwhile: now `decided`, or nothing open.
      timelines.push(diff);
    }
    // A timeline it adds: every clip is new.
    for (const file of proposal.files ?? []) {
      const added = parseIncoming(timelinePath(root, file.timeline), file.text);
      const changes: ClipChange[] = added.tracks.flatMap((track) =>
        track.kind === "subtitles" ? [] : track.clips.map((clip) => ({ clip: clip.id, change: "added" as const, before: null, after: { track: track.id, clip } })),
      );
      timelines.push(await this.#placeDiff(root, file.timeline, await projectFps(root), proposal.tx, changes));
    }
    return { tx: proposal.tx, timelines };
  }

  /** `history.diff` result of `changes`; ends are derived like `show`'s. */
  async #placeDiff(root: string, id: string, fps: number, target: string, changes: ClipChange[]): Promise<HistoryDiffResult> {
    const grid = new FrameGrid(fps);
    const nested = this.#nestedDurations(root, [timelineRel(id)], grid);
    const place = async (placed: PlacedClip | null): Promise<ClipPlace | null> => {
      if (!placed) return null;
      let end: number | null;
      try {
        end = await clipEnd(placed.clip, grid, nested);
      } catch (error) {
        if (!(error instanceof NestedTimelineError)) throw error;
        end = null;
      }
      return { track: placed.track, start: placed.clip.start, end };
    };
    const clips = [];
    for (const change of changes) {
      clips.push({ clip: change.clip, change: change.change, before: await place(change.before), after: await place(change.after) });
    }
    return { timeline: id, target, clips };
  }

  /**
   * Timeline `id` as a read with `view` shows it (ADR 0019 §5): the file, or
   * the open proposal's version of it (the file when the proposal does not
   * change it; the kept file when it adds the timeline), with the open
   * proposal's id and state.
   */
  viewTimeline(root: string, id: string, view: TimelineViewName): Promise<Viewed> {
    return this.#turn(root, id, async () => {
      let loaded: { timeline: Timeline; fps: number };
      try {
        loaded = await this.#current(root, id);
      } catch (error) {
        const open = (await this.#book(root)).proposal;
        const kept = view === "proposal" && open ? proposedFile(open, id) : undefined;
        if (!kept || !unreadable(error)) throw error;
        const timeline = parseIncoming(timelinePath(root, id), kept.text);
        return { timeline, fps: await projectFps(root), view, proposal: { tx: open!.tx, state: open!.state } };
      }
      const { timeline, fps } = loaded;
      const book = await this.#book(root);
      let shown = timeline;
      if (view === "proposal" && book.proposal && (await this.#sync(root, id, book, timeline, fps))) {
        const part = book.proposal?.parts.find((candidate) => candidate.timeline === id);
        if (part) shown = structuredClone(part.shadow);
      }
      const open = book.proposal;
      return { timeline: shown, fps, view, proposal: open ? { tx: open.tx, state: open.state } : null };
    });
  }

  /** The open proposal of `root` (ADR 0019); null when none. */
  async proposal(root: string): Promise<Proposal | null> {
    const open = (await this.#book(root)).proposal;
    return open ? summary(open) : null;
  }

  /** Review mode of `root` for `status` and `proposal.status`: the switch, the open proposal, the last decisions. */
  async review(root: string): Promise<ReviewState> {
    const real = await this.#realRoot(root);
    const open = (await this.#book(root)).proposal;
    return {
      enabled: await this.#reviewEnabled(root),
      proposal: open ? summary(open) : null,
      decisions: (await readDecisions(real)).slice(-MAX_DECISIONS).reverse(),
    };
  }

  /**
   * Transaction `tx` closed: its proposal, if building, waits for review now.
   * Returns the proposal's id and state while it is open; null when `tx`
   * holds none. Idempotent.
   */
  async ready(tx: string): Promise<{ tx: string; state: "building" | "ready" } | null> {
    for (const book of this.#loaded.values()) {
      const open = book.proposal;
      if (open?.tx !== tx) continue;
      if (open.state === "building") {
        open.state = "ready";
        await this.#persist(book);
        this.#emit(book, open, "ready");
      }
      return { tx, state: open.state };
    }
    return null;
  }

  /** `tx abort` of `tx`: drop its proposal while building (nothing reached the file). True when one was dropped. */
  async abortProposal(tx: string): Promise<boolean> {
    for (const book of this.#loaded.values()) {
      const open = book.proposal;
      if (open?.tx === tx && open.state === "building") {
        await this.#close(book, open, "aborted", []);
        return true;
      }
    }
    return false;
  }

  /**
   * ProposalPending when `author` (not `ui`) may not open a transaction now (ADR 0019 §6): a proposal is open in
   * project `root`, or, without `root`, in any loaded project.
   */
  async assertCanBegin(author: string, root?: string): Promise<void> {
    if (author === "ui") return;
    if (root !== undefined) {
      const open = (await this.#book(root)).proposal;
      if (open) throw proposalPending(open);
      return;
    }
    for (const book of this.#loaded.values()) if (book.proposal) throw proposalPending(book.proposal);
  }

  /**
   * Apply ready proposal `tx` (ADR 0019 §8): rebase check again, then journal
   * its operations in order under their author, transaction and label, each
   * marked `proposal: <tx>`, on every timeline or none. Throws ProposalState
   * (`building`, `decided`, `unknown`, `stale`) or the engine's errors.
   */
  async acceptProposal(root: string, tx: string): Promise<{ tx: string; operations: OperationResult[] }> {
    const real = await this.#realRoot(root);
    const book = await this.#book(root);
    const proposal = await this.#decidable(real, book, tx);
    if (proposal.state !== "ready") throw proposalState(tx, "building", `Proposal ${tx} is still building: its transaction is open. Accept it once it is ready.`);
    const keys = await Promise.all(proposalTimelines(proposal).map((id) => this.#key(root, id)));
    return this.#exclusive(keys, async () => {
      if (book.proposal !== proposal) await this.#decidable(real, book, tx);
      const installs: { file: ProposedFile; timeline: Timeline; journaled: Timeline | null; patch: TimelinePatch | null; applied: AppliedOperation | null }[] = [];
      for (const file of proposal.files ?? []) {
        const timeline = parseIncoming(timelinePath(root, file.timeline), file.text);
        if (await this.#readable(root, file.timeline)) {
          await this.#close(book, proposal, "stale", [file.timeline]);
          throw proposalState(tx, "stale", `Proposal ${tx} is out of date: ${timelineRel(file.timeline)} exists now. It was closed unapplied.`, [file.timeline]);
        }
        // As `writeFile` does without review mode: on top of what the journal last recorded, else as is.
        const journaled = await this.#journaledBase(root, file.timeline, file.text, timeline);
        const planned = journaled ? await this.#plan(root, file.timeline, journaled, diffTimelines(journaled, timeline), await projectFps(root)) : null;
        installs.push({ file, timeline, journaled, patch: planned?.patch ?? null, applied: planned?.applied ?? null });
      }
      const planned: { part: ProposalPart; steps: { before: Timeline; applied: AppliedOperation; op: ProposedOp }[] }[] = [];
      for (const part of proposal.parts) {
        const { timeline: current, fps } = await this.#current(root, part.timeline);
        if (!(await this.#sync(root, part.timeline, book, current, fps))) {
          const decision = (await readDecisions(real)).findLast((candidate) => candidate.tx === tx);
          const conflicts = decision?.conflicts ?? [];
          throw proposalState(tx, "stale", `Proposal ${tx} is out of date: you changed ${conflicts.join(", ") || "the same timeline"} too. It was closed unapplied.`, conflicts);
        }
        const steps = [];
        let state = current;
        for (const op of part.ops) {
          const applied = await applyOperation(state, { op: "timeline.patch", args: op.patch }, this.#context(root, part.timeline, fps, op.op));
          steps.push({ before: state, applied, op });
          state = applied.timeline;
        }
        planned.push({ part, steps });
      }
      const operations: OperationResult[] = [];
      const txRef = { id: proposal.tx, label: proposal.label };
      for (const { file, timeline, journaled, patch, applied } of installs) {
        const id = file.timeline;
        if (journaled && patch && applied) {
          const context = { root, cwd: root, timeline: id, author: proposal.author, tx: txRef };
          operations.push(await this.#record(context, journaled, applied, "timeline.patch", patch, [], { id: newOpId(), proposal: proposal.tx }));
        } else if (journaled) {
          await this.#announce(root, id, (await this.#extend(root, id, journaled, {}, await projectFps(root), { author: proposal.author, tx: txRef })).timeline);
        } else {
          await this.#install(root, id, file.text, timeline);
        }
      }
      for (const { part, steps } of planned) {
        const context = { root, cwd: root, timeline: part.timeline, author: proposal.author, tx: txRef };
        for (const { before, applied, op } of steps) {
          operations.push(await this.#record(context, before, applied, op.op, op.args, [], { id: op.id, proposal: proposal.tx }));
        }
      }
      await this.#close(book, proposal, "accepted", []);
      return { tx, operations };
    });
  }

  /** Refuse open proposal `tx`, ready or building (ADR 0019 §8): nothing is journaled. Throws ProposalState (`decided`, `unknown`). */
  async rejectProposal(root: string, tx: string): Promise<{ tx: string }> {
    const real = await this.#realRoot(root);
    const book = await this.#book(root);
    const proposal = await this.#decidable(real, book, tx);
    // Under the timelines' locks: an accept already writing them finishes first, then this finds it decided.
    const keys = await Promise.all(proposalTimelines(proposal).map((id) => this.#key(root, id)));
    await this.#exclusive(keys, async () => this.#close(book, await this.#decidable(real, book, tx), "rejected", []));
    return { tx };
  }

  /**
   * `proposal.wait`: resolves when the open proposal closes, or with
   * `pending` after `timeoutMs`. Without one, the last decision or `none`.
   * `reader` (journal author) is told about its own closed proposal here, not again on its next change.
   */
  async waitProposal(root: string, timeoutMs: number, reader: string): Promise<ProposalWaitResult> {
    const real = await this.#realRoot(root);
    const book = await this.#book(root);
    const told = (result: ProposalWaitResult): ProposalWaitResult => {
      if (result.tx !== null && book.notices.get(reader)?.tx === result.tx) book.notices.delete(reader);
      return result;
    };
    const open = book.proposal;
    if (!open) {
      // A proposal closing right now is not logged yet.
      await book.closing;
      const last = (await readDecisions(real)).at(-1);
      return told(last ? waitOutcome(last) : { outcome: "none", tx: null, label: null, author: null, conflicts: [], proposal: null });
    }
    return new Promise((resolve) => {
      const done = (decision: ProposalDecision) => {
        clearTimeout(timer);
        resolve(told(waitOutcome(decision)));
      };
      const timer = setTimeout(() => {
        book.waiters.delete(done);
        const still = book.proposal ?? open;
        resolve({ outcome: "pending", tx: still.tx, label: still.label, author: still.author, conflicts: [], proposal: summary(still) });
      }, timeoutMs);
      // A daemon shutting down must not wait for it.
      timer.unref?.();
      book.waiters.add(done);
    });
  }

  /** `gc` of closed proposal files older than 7 days (ADR 0019 §8); the open one stays. */
  async gcProposals(root: string, dryRun: boolean): Promise<GcEntry[]> {
    const open = (await this.#book(root)).proposal;
    return sweepProposals(root, { dryRun, open: open?.tx ?? null });
  }

  /** The open proposal when it is `tx`; else ProposalState `decided` (a logged decision) or `unknown`. */
  async #decidable(real: string, book: Book, tx: string): Promise<OpenProposal> {
    if (book.proposal?.tx === tx) return book.proposal;
    await book.closing;
    const decided =(await readDecisions(real)).findLast((decision) => decision.tx === tx);
    if (decided) throw proposalState(tx, "decided", `Proposal ${tx} was already decided: ${decided.outcome}.`, decided.conflicts);
    throw proposalState(tx, "unknown", `No open proposal ${tx}. See \`frameshell proposal status\`.`);
  }

  /**
   * Where a change by `author` in `tx` goes (ADR 0019 §1, §6): null = the
   * file, as without review mode; else the proposal it joins (a new one when
   * review mode is on and none is open). Throws ProposalPending when another
   * proposal is open (or the author's own is ready), and ProposalState once
   * after the author's building proposal closed unapplied.
   */
  async #route(root: string, author: string, tx: TxRef): Promise<Route | null> {
    if (author === "ui") return null;
    const book = await this.#book(root);
    const notice = book.notices.get(author);
    if (notice) {
      book.notices.delete(author);
      throw closedError(notice);
    }
    for (;;) {
      while (book.creating) await book.creating;
      const open = book.proposal;
      if (open) {
        if (open.tx === tx.id && open.state === "building") return { book, proposal: open, created: false, release: () => {} };
        throw proposalPending(open);
      }
      if (!(await this.#reviewEnabled(root))) return null;
      if (book.creating || book.proposal) continue;
      let release!: () => void;
      book.creating = new Promise<void>((resolve) => (release = resolve));
      const proposal: OpenProposal = { tx: tx.id, label: tx.label, author, state: "building", openedAt: new Date().toISOString(), parts: [] };
      return {
        book,
        proposal,
        created: true,
        release: () => {
          book.creating = null;
          release();
        },
      };
    }
  }

  /**
   * Run `make` on the proposal's version of timeline `id` and add what it
   * applied to the proposal as one operation, saved before this returns.
   * Caller holds the turn. Null when `make` changed nothing.
   */
  async #propose(
    root: string,
    id: string,
    route: Route,
    who: { author: string; tx: TxRef },
    make: (base: Timeline, current: Timeline, fps: number, settings: EditSettings) => Promise<Proposed | null>,
  ): Promise<{ result: OperationResult; shadow: Timeline } | null> {
    const { book, proposal } = route;
    if (proposedFile(proposal, id)) throw keptAside(proposal, id);
    const { timeline: current, fps, ...settings } = await this.#current(root, id);
    if (!route.created && !(await this.#sync(root, id, book, current, fps))) {
      const notice = book.notices.get(who.author) ?? { tx: proposal.tx, reason: "stale" as const, conflicts: [] };
      book.notices.delete(who.author);
      throw closedError(notice);
    }
    let part = proposal.parts.find((candidate) => candidate.timeline === id);
    const base = part ? part.shadow : current;
    const made = await make(base, current, fps, settings);
    if (!made) return null;
    const { applied } = made;
    const op: ProposedOp = {
      id: newOpId(),
      op: made.op,
      args: made.args,
      patch: diffTimelines(base, applied.timeline),
      inverse: applied.inverse,
      at: new Date().toISOString(),
    };
    const added = !part;
    if (!part) proposal.parts.push((part = { timeline: id, base: current, shadow: current, ops: [] }));
    const previous = part.shadow;
    part.ops.push(op);
    part.shadow = applied.timeline;
    if (route.created) book.proposal = proposal;
    try {
      await this.#persist(book);
    } catch (error) {
      part.ops.pop();
      part.shadow = previous;
      if (added) proposal.parts.pop();
      if (route.created) book.proposal = null;
      throw error;
    }
    this.#emit(book, proposal, "building");
    const operation: OperationRecord = { id: op.id, op: op.op, args: op.args, inverse: op.inverse, author: who.author, tx: who.tx.id, revisionBefore: base.revision };
    return {
      result: {
        timeline: id,
        revision: applied.timeline.revision,
        operation,
        changes: applied.changes,
        snaps: applied.snaps,
        warnings: [...(made.warnings ?? []), ...applied.warnings],
      },
      shadow: applied.timeline,
    };
  }

  /**
   * Bring the open proposal's part for timeline `id` up to `current` (ADR
   * 0019 §7): replay it there when the person's changes since its base touch
   * none of its keys, else close it as stale. Caller holds the turn. False
   * when it went stale.
   */
  async #sync(root: string, id: string, book: Book, current: Timeline, fps: number): Promise<boolean> {
    const proposal = book.proposal;
    const part = proposal?.parts.find((candidate) => candidate.timeline === id);
    if (!proposal || !part || timelineHash(part.base) === timelineHash(current)) return true;
    const rebased = await this.#rebase(root, id, fps, part, current);
    if (book.proposal !== proposal) return false;
    if (!rebased.ok) {
      await this.#close(book, proposal, "stale", rebased.conflicts);
      return false;
    }
    Object.assign(part, { base: current, ops: rebased.ops, shadow: rebased.shadow });
    await this.#persist(book);
    this.#emit(book, proposal, proposal.state);
    return true;
  }

  /** `part` replayed on `current`, or the ids that make it stale: keys shared with the person's changes, or a replay breaking a rule. */
  async #rebase(
    root: string,
    id: string,
    fps: number,
    part: Omit<ProposalPart, "shadow"> & { shadow?: Timeline },
    current: Timeline,
  ): Promise<{ ok: true; ops: ProposedOp[]; shadow: Timeline } | { ok: false; conflicts: string[] }> {
    if (timelineHash(part.base) !== timelineHash(current)) {
      const person = [diffTimelines(part.base, current), diffTimelines(current, part.base)];
      const ours = part.ops.flatMap((op) => [op.patch, op.inverse.args]);
      const conflicts = overlappingIds(ours, person, [part.base, current, ...(part.shadow ? [part.shadow] : [])]);
      if (conflicts.length > 0) return { ok: false, conflicts };
    }
    let state = current;
    const ops: ProposedOp[] = [];
    for (const op of part.ops) {
      try {
        const applied = await applyOperation(state, { op: "timeline.patch", args: op.patch }, this.#context(root, id, fps, op.op));
        ops.push({ ...op, inverse: applied.inverse });
        state = applied.timeline;
      } catch {
        // A replay breaking a rule (overlap, removed track) makes it stale, naming what that operation touches.
        return { ok: false, conflicts: touchedIds(op.patch) };
      }
    }
    return { ok: true, ops, shadow: state };
  }

  /**
   * Close the open `proposal` (ADR 0019 §8): `accepted` drops its file (its
   * operations are journaled), other outcomes keep it for recovery. Logs the
   * decision, wakes `proposal.wait` and reports it.
   */
  async #close(book: Book, proposal: OpenProposal, outcome: ProposalOutcome, conflicts: string[]): Promise<void> {
    const real = book.root;
    if (book.proposal !== proposal) return;
    book.proposal = null;
    const at = new Date().toISOString();
    const building = proposal.state === "building";
    const write = book.saving.then(() =>
      outcome === "accepted" ? removeProposal(real, proposal.tx) : saveProposal(real, proposal, { state: outcome, at, conflicts }),
    );
    book.saving = write.catch(() => {});
    const decision: ProposalDecision = {
      tx: proposal.tx,
      label: proposal.label,
      author: proposal.author,
      outcome,
      timelines: proposalTimelines(proposal),
      conflicts,
      at,
    };
    if (building && (outcome === "stale" || outcome === "rejected")) {
      book.notices.set(proposal.author, { tx: proposal.tx, reason: outcome, conflicts });
    }
    const logged = write.then(() => appendDecision(real, decision));
    book.closing = logged.catch(() => {});
    try {
      await logged;
    } finally {
      book.closing = null;
      for (const waiter of book.waiters) waiter(decision);
      book.waiters.clear();
      this.#emit(book, proposal, outcome, conflicts, building && (outcome === "stale" || outcome === "rejected"));
    }
  }

  /** Save the open proposal of `book` (whatever it is when the write starts), after earlier writes. */
  #persist(book: Book): Promise<void> {
    const write = book.saving.then(async () => {
      if (book.proposal) await saveProposal(book.root, book.proposal);
    });
    book.saving = write.catch(() => {});
    return write;
  }

  #emit(book: Book, proposal: OpenProposal, state: ProposalState, conflicts: string[] = [], endsTx = false): void {
    this.#options.onProposal?.({
      root: book.root,
      tx: proposal.tx,
      label: proposal.label,
      author: proposal.author,
      state,
      operations: operationCount(proposal),
      timelines: proposalTimelines(proposal),
      conflicts,
      endsTx,
    });
  }

  #reviewEnabled(root: string): Promise<boolean> {
    const enabled = this.#options.reviewEnabled;
    return enabled ? this.#realRoot(root).then(enabled) : Promise.resolve(false);
  }

  /** Review mode state of `root`, loaded once: an open proposal on disk is rebuilt on the current files and checked (ADR 0019 §4). */
  #book(root: string): Promise<Book> {
    return this.#realRoot(root).then((real) => {
      let book = this.#books.get(real);
      if (!book) {
        book = this.#loadBook(real);
        this.#books.set(real, book);
        book.then(
          (loaded) => this.#loaded.set(real, loaded),
          () => this.#books.delete(real),
        );
      }
      return book;
    });
  }

  async #loadBook(real: string): Promise<Book> {
    const book: Book = { root: real, proposal: null, creating: null, notices: new Map(), waiters: new Set(), saving: Promise.resolve(), closing: null };
    const stored = await loadOpenProposals(real);
    const latest = stored.pop();
    // Only one can be open; older leftovers of a crash are closed.
    for (const old of stored) {
      book.proposal = { ...old, parts: old.parts.map((part) => ({ ...part, shadow: part.base })) };
      await this.#close(book, book.proposal, "stale", []);
    }
    if (!latest) return book;
    const fps = await projectFps(real);
    const proposal: OpenProposal = { ...latest, parts: latest.parts.map((part) => ({ ...part, shadow: part.base })) };
    book.proposal = proposal;
    for (const part of proposal.parts) {
      let current: Timeline;
      try {
        current = await readTimelineFile(real, timelineRel(part.timeline));
      } catch {
        await this.#close(book, proposal, "stale", [part.timeline]);
        return book;
      }
      const rebased = await this.#rebase(real, part.timeline, fps, part, current);
      if (!rebased.ok) {
        await this.#close(book, proposal, "stale", rebased.conflicts);
        return book;
      }
      Object.assign(part, { base: current, ops: rebased.ops, shadow: rebased.shadow });
    }
    for (const file of proposal.files ?? []) {
      // A timeline it adds that is readable now (the person wrote it), or kept text that no longer parses.
      const readable = await readTimelineFile(real, timelineRel(file.timeline)).then(() => true, (error: unknown) => (unreadable(error) ? false : Promise.reject(error)));
      if (readable || !parseText(file.text).ok) {
        await this.#close(book, proposal, "stale", [file.timeline]);
        return book;
      }
    }
    if (proposal.state === "building" && !this.#options.txOpen?.(proposal.tx)) proposal.state = "ready";
    await this.#persist(book);
    return book;
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
    accepted?: { id: string; proposal: string },
  ): Promise<OperationResult> {
    const { root, timeline: id } = call;
    const path = timelinePath(root, id);
    const text = `${JSON.stringify(applied.timeline, null, 2)}\n`;
    await writeTextAtomic(path, text);
    this.#known.set(await this.#key(root, id), { text, timeline: applied.timeline });
    const operation: OperationRecord = {
      id: accepted?.id ?? newOpId(),
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
      ...(accepted ? { proposal: accepted.proposal } : {}),
    };
    await appendJournal(root, id, entry);
    // Only catch-up of edits made while no daemon runs needs it; a lost snapshot must not fail an applied operation.
    await writeHead(root, id, text).catch(() => {});
    this.#options.onChanged?.({
      root: await this.#realRoot(root),
      timeline: id,
      revision: applied.timeline.revision,
      author: call.author,
      changes: applied.changes,
    });
    // ADR 0019 §7: the person's edit rebases the open proposal, or makes it stale.
    if (call.author === "ui") {
      const book = await this.#book(root);
      if (book.proposal) await this.#sync(root, id, book, applied.timeline, await projectFps(root));
    }
    return { timeline: id, revision: applied.timeline.revision, operation, changes: applied.changes, snaps: applied.snaps, warnings: [...warnings, ...applied.warnings] };
  }

  /**
   * Compact dump for agents (`timeline.show`). A clip whose nested timeline
   * is missing, invalid or cyclic does not fail the dump: its `end` is null,
   * the track end and duration are null, and `problems` says how to fix it.
   * `view` picks the file or the open proposal's version (ADR 0019).
   */
  async show(
    root: string,
    id: string,
    view: TimelineViewName = "current",
  ): Promise<TimelineView & Pick<Viewed, "view" | "proposal">> {
    const { timeline, fps, proposal } = await this.viewTimeline(root, id, view);
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
        ...(track.kind === "program" ? { group: track.group } : {}),
        ...(track.kind === "subtitles" && track.style ? { style: track.style } : {}),
        clips,
      });
    }
    return {
      view,
      proposal,
      timeline: id,
      path: timelineRel(id),
      revision: timeline.revision,
      fps,
      duration,
      tracks,
      ...(timeline.groups ? { groups: timeline.groups } : {}),
      problems,
    };
  }

  /** Track summaries in stacking order (`track.list`); `view` as for {@link TimelineService.show}. */
  async tracks(
    root: string,
    id: string,
    shown: TimelineViewName = "current",
  ): Promise<
    Pick<Viewed, "view" | "proposal"> & { timeline: string; revision: number; tracks: TrackSummary[]; problems: TimelineProblem[] }
  > {
    const view = await this.show(root, id, shown);
    return {
      view: view.view,
      proposal: view.proposal,
      timeline: id,
      revision: view.revision,
      tracks: view.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        follows: track.follows,
        ...(track.group !== undefined ? { group: track.group } : {}),
        ...(track.style ? { style: track.style } : {}),
        clips: track.clips.length,
        end: track.clips.reduce<number | null>((end, clip) => (end === null || clip.end === null ? null : Math.max(end, clip.end)), 0),
      })),
      problems: view.problems,
    };
  }

  #context(root: string, id: string, fps: number, op: string, settings: EditSettings = {}): EditContext {
    const grid = new FrameGrid(fps);
    const newId = this.#options.newId ?? ((prefix: "c" | "t" | "g") => `${prefix}_${randomBytes(3).toString("hex")}`);
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
      ...settings,
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
  load(root: string, id: string): Promise<{ timeline: Timeline; fps: number } & EditSettings> {
    return this.#turn(root, id, () => this.#current(root, id));
  }

  /** {@link TimelineService.load} for callers already holding the file's turn. */
  async #current(root: string, id: string): Promise<{ timeline: Timeline; fps: number } & EditSettings> {
    const project = await readEnclosingProject(root);
    const fps = project?.config.fps ?? 30;
    const window = project?.config.editing?.snapWindow;
    const snap: EditSettings = {
      ...(window !== undefined ? { snapWindow: window } : {}),
      ...(project?.config.kind === "image" ? { defaultStillDuration: 1 / fps } : {}),
    };
    const path = timelinePath(root, id);
    const key = await this.#key(root, id);
    const baseline = await this.#baseline(root);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#known.delete(key);
      baseline.delete(id);
      throw await timelineNotFound(root, id);
    }
    const known = this.#known.get(key);
    if (known?.timeline && known.text === text) return { timeline: structuredClone(known.timeline), fps, ...snap };
    if (known?.timeline) return { timeline: await this.#absorb(root, id, text, known.timeline, fps), fps, ...snap };
    // First sight, or no valid version yet: the journal is the only thing to diff against.
    const parsed = parseText(text);
    if (!parsed.ok) {
      this.#known.set(key, { text, timeline: null });
      throw invalidFile(path, parsed.error);
    }
    const journaled = await this.#journaledBase(root, id, text, parsed.value);
    if (!journaled) {
      const arrived = await this.#reviewsArrival(root, id, known !== undefined, baseline);
      if (arrived) {
        // Review mode (ADR 0019 §9): a new or repaired file is kept with a proposal, not taken in.
        const previous = known?.text ?? null;
        await this.#proposeArrival(root, id, arrived, text, previous);
        if (previous === null) throw await timelineNotFound(root, id);
        throw invalidFile(path, (parseText(previous) as { error: string }).error);
      }
      this.#known.set(key, { text, timeline: parsed.value });
      if (known) await this.#announce(root, id, parsed.value);
      return { timeline: structuredClone(parsed.value), fps, ...snap };
    }
    // Edited while no daemon watched: journal it now, so `revert` sees it (no revision check: nothing to be stale against).
    let timeline: Timeline;
    let result: OperationResult | null = null;
    const book = await this.#book(root);
    if (book.proposal || (await this.#reviewEnabled(root))) {
      // Review mode (ADR 0019 §9): the catch-up becomes a proposal like any direct edit.
      let planned: { patch: TimelinePatch; applied: AppliedOperation } | null = null;
      let rejected = false;
      try {
        planned = await this.#plan(root, id, journaled, diffTimelines(journaled, parsed.value), fps);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        await this.#reject(root, id, text, journaled, "invalid", error.message);
        rejected = true;
      }
      if (planned) await this.#proposeEdit(root, id, book, text, journaled, planned);
      // Nothing to review: written back as `#extend` does with an empty patch.
      else if (!rejected) await this.#restore(root, id, journaled);
      if (known) await this.#announce(root, id, journaled);
      return { timeline: structuredClone(journaled), fps, ...snap };
    }
    try {
      ({ timeline, result } = await this.#extend(root, id, journaled, diffTimelines(journaled, parsed.value), fps, this.#fileSaver()));
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      await this.#reject(root, id, text, journaled, "invalid", error.message);
      timeline = journaled;
    }
    if (!result && known) await this.#announce(root, id, timeline);
    return { timeline: structuredClone(timeline), fps, ...snap };
  }

  /**
   * Timeline the journal last recorded for `id`, when the file (`text`,
   * parsed as `incoming`) differs from it and the head snapshot can say how;
   * null when there is no journal, the file matches it, or the snapshot is
   * missing or behind (a journal from an older daemon, a crash in between):
   * then the change stays a gap `revert` refuses to cross. A file that
   * matches refreshes a missing or stale snapshot.
   */
  async #journaledBase(root: string, id: string, text: string, incoming: Timeline): Promise<Timeline | null> {
    const last = (await readJournal(root, id)).at(-1);
    if (!last) return null;
    const head = await readHead(root, id);
    const current = head !== null && timelineHash(head) === last.hash;
    if (timelineHash(incoming) === last.hash) {
      if (!current) await writeHead(root, id, text);
      return null;
    }
    return current ? head : null;
  }

  /**
   * Apply `patch` to `base` as one journaled `timeline.patch` by `saver`,
   * bumping `base`'s revision. An empty patch journals nothing: `base` is
   * written back (dropping changes outside tracks and clips, such as the
   * revision). Throws the engine's errors, without writing.
   */
  async #extend(
    root: string,
    id: string,
    base: Timeline,
    patch: TimelinePatch,
    fps: number,
    saver: Saver,
  ): Promise<{ timeline: Timeline; result: OperationResult | null }> {
    if (isEmptyPatch(patch)) {
      const text = `${JSON.stringify(base, null, 2)}\n`;
      await writeTextAtomic(timelinePath(root, id), text);
      this.#known.set(await this.#key(root, id), { text, timeline: base });
      return { timeline: structuredClone(base), result: null };
    }
    const applied = await applyOperation(base, { op: "timeline.patch", args: patch }, this.#context(root, id, fps, "timeline.patch"));
    const result = await this.#record({ root, cwd: root, timeline: id, ...saver }, base, applied, "timeline.patch", patch);
    return { timeline: applied.timeline, result };
  }

  /**
   * A direct edit on disk: journal it, or restore `base` and keep the edit.
   * In review mode (ADR 0019 §9) a valid edit becomes a ready proposal
   * instead, and `base` goes back on disk. Returns the timeline now on disk.
   */
  async #absorb(root: string, id: string, text: string, base: Timeline, fps: number): Promise<Timeline> {
    const book = await this.#book(root);
    if (book.proposal || (await this.#reviewEnabled(root))) {
      let planned: { patch: TimelinePatch; applied: AppliedOperation } | null;
      try {
        const path = timelinePath(root, id);
        planned = await this.#plan(root, id, base, diffTimelines(base, checkRevision(id, path, parseIncoming(path, text), base)), fps);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        await this.#reject(root, id, text, base, error.code === ErrorCode.StaleRevision ? "stale" : "invalid", error.message);
        return structuredClone(base);
      }
      // Same groups, tracks and clips (formatting, key order): nothing to review.
      if (!planned) return (await this.#acceptEdit(root, id, text, base, fps)).timeline;
      await this.#proposeEdit(root, id, book, text, base, planned);
      return structuredClone(base);
    }
    try {
      return (await this.#acceptEdit(root, id, text, base, fps)).timeline;
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      const reason = error.code === ErrorCode.StaleRevision ? "stale" : "invalid";
      await this.#reject(root, id, text, base, reason, error.message);
      return structuredClone(base);
    }
  }

  /** `patch` applied to `base` by the engine without writing; null when it changes nothing. Throws the engine's errors. */
  async #plan(root: string, id: string, base: Timeline, patch: TimelinePatch, fps: number): Promise<{ patch: TimelinePatch; applied: AppliedOperation } | null> {
    if (isEmptyPatch(patch)) return null;
    return { patch, applied: await applyOperation(base, { op: "timeline.patch", args: patch }, this.#context(root, id, fps, "timeline.patch")) };
  }

  /**
   * The project's book when review mode takes in timeline file `id` as a
   * proposal (ADR 0019 §9) rather than as a timeline: it is new since the
   * project was first read (or was seen missing), or `wasUnreadable`, has no
   * journal, and review mode is on or a proposal is open. Null otherwise.
   */
  async #reviewsArrival(root: string, id: string, wasUnreadable: boolean, baseline: Set<string>): Promise<Book | null> {
    if (!wasUnreadable && baseline.has(id)) return null;
    const book = await this.#book(root);
    if (!book.proposal && !(await this.#reviewEnabled(root))) return null;
    return (await readJournal(root, id)).length === 0 ? book : null;
  }

  /**
   * A valid timeline file `text` that appeared on disk while review mode
   * applies (see {@link TimelineService.#reviewsArrival}): a ready proposal by
   * author `file` that keeps it, or a rejection with reason `proposal-pending`
   * when another proposal is open. Either way `previous` (the unreadable text
   * it replaced; null: none) is back on disk. Caller holds the turn.
   */
  async #proposeArrival(root: string, id: string, book: Book, text: string, previous: string | null): Promise<void> {
    const restore = { unread: previous };
    while (book.creating) await book.creating;
    if (book.proposal) {
      const { message } = proposalPending(book.proposal);
      await this.#reject(root, id, text, restore, "proposal-pending", `${message} The file was not taken in; write it again once the proposal is decided.`);
      return;
    }
    const { tx } = this.#fileSaver();
    const proposal: OpenProposal = {
      tx: tx.id,
      label: `${previous === null ? "Add" : "Replace"} ${timelineRel(id)}`,
      author: "file",
      state: "ready",
      openedAt: new Date().toISOString(),
      parts: [],
      files: [{ timeline: id, text }],
    };
    book.proposal = proposal;
    try {
      await this.#persist(book);
    } catch (error) {
      book.proposal = null;
      throw error;
    }
    await this.#putBack(root, id, restore);
    this.#emit(book, proposal, "ready");
  }

  /** Timeline ids in `root`'s `timelines/` when it was first read; see {@link TimelineService.#baselines}. */
  #baseline(root: string): Promise<Set<string>> {
    return this.#realRoot(root).then((real) => {
      let ids = this.#baselines.get(real);
      if (!ids) this.#baselines.set(real, (ids = listTimelines(real).then((names) => new Set(names))));
      return ids;
    });
  }

  /** Whether timeline `id` has a readable file now. Caller holds the turn. */
  async #readable(root: string, id: string): Promise<boolean> {
    try {
      await this.#current(root, id);
      return true;
    } catch (error) {
      if (!unreadable(error)) throw error;
      return false;
    }
  }

  /**
   * A valid direct edit `text` of timeline `id` while review mode applies:
   * a ready proposal by author `file`, or a rejection with reason
   * `proposal-pending` when another proposal is open. Either way `base` is
   * back on disk. Caller holds the turn.
   */
  async #proposeEdit(
    root: string,
    id: string,
    book: Book,
    text: string,
    base: Timeline,
    planned: { patch: TimelinePatch; applied: AppliedOperation },
  ): Promise<void> {
    while (book.creating) await book.creating;
    if (book.proposal) {
      const { message } = proposalPending(book.proposal);
      await this.#reject(root, id, text, base, "proposal-pending", `${message} The edit was not applied; reapply it once the proposal is decided.`);
      return;
    }
    const at = new Date().toISOString();
    const { tx } = this.#fileSaver();
    const op: ProposedOp = { id: newOpId(), op: "timeline.patch", args: planned.patch, patch: planned.patch, inverse: planned.applied.inverse, at };
    const proposal: OpenProposal = {
      tx: tx.id,
      label: `Edit ${timelineRel(id)}`,
      author: "file",
      state: "ready",
      openedAt: at,
      parts: [{ timeline: id, base, shadow: planned.applied.timeline, ops: [op] }],
      edit: { timeline: id, text },
    };
    book.proposal = proposal;
    try {
      await this.#persist(book);
    } catch (error) {
      book.proposal = null;
      throw error;
    }
    await this.#restore(root, id, base);
    this.#emit(book, proposal, "ready");
  }

  /**
   * Journal `text` as one `timeline.patch` operation by `saver` (default:
   * author `file`) on top of `base`, bumping the revision. Throws, without
   * writing: InvalidProjectFile, StaleRevision, or the engine's errors for a
   * patch breaking timeline rules.
   */
  async #acceptEdit(
    root: string,
    id: string,
    text: string,
    base: Timeline,
    fps: number,
    saver?: Saver,
  ): Promise<{ timeline: Timeline; result: OperationResult | null }> {
    const path = timelinePath(root, id);
    const incoming = checkRevision(id, path, parseIncoming(path, text), base);
    const patch = diffTimelines(base, incoming);
    if (isEmptyPatch(patch)) {
      // Same groups, tracks and clips (formatting, key order): nothing to journal.
      await writeTextAtomic(path, text);
      this.#known.set(await this.#key(root, id), { text, timeline: base });
      return { timeline: structuredClone(base), result: null };
    }
    return this.#extend(root, id, base, patch, fps, saver ?? this.#fileSaver());
  }

  /** Author `file` in a transaction from {@link TimelineServiceOptions.fileTx}. */
  #fileSaver(): Saver {
    return { author: "file", tx: this.#options.fileTx?.() ?? { id: newTxId(), label: null } };
  }

  /** Restore `base` on disk, keep `text` under `.frameshell/rejected/`, report it (SPEC §6.4). */
  async #reject(
    root: string,
    id: string,
    text: string,
    base: Restore,
    reason: RejectionInfo["reason"],
    message: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    const stamp = at.replace(/[:.]/g, "-"); // `:` is not allowed in Windows file names.
    let preserved = `.frameshell/rejected/${stamp}-${id}.json`;
    for (let n = 2; await exists(join(root, preserved)); n++) preserved = `.frameshell/rejected/${stamp}-${n}-${id}.json`;
    await writeTextAtomic(join(root, preserved), text);
    await this.#putBack(root, id, base);
    const real = await this.#realRoot(root);
    const rejection: TimelineRejection = {
      root: real,
      timeline: id,
      reason,
      message,
      preserved,
      revision: revisionOf(text),
      current: "unread" in base ? null : base.revision,
      at,
    };
    const { root: _root, ...record } = rejection;
    await recordRejection(root, record);
    this.#options.onRejected?.(rejection);
  }

  /** Put `restore` back on disk: the daemon's version, else the earlier unreadable text or no file. */
  async #putBack(root: string, id: string, restore: Restore): Promise<void> {
    if (!("unread" in restore)) return this.#restore(root, id, restore);
    const key = await this.#key(root, id);
    if (restore.unread === null) {
      await rm(timelinePath(root, id), { force: true });
      this.#known.delete(key);
      return;
    }
    await writeTextAtomic(timelinePath(root, id), restore.unread);
    this.#known.set(key, { text: restore.unread, timeline: null });
  }

  /** Put `base` back on disk as the known version of timeline `id`. */
  async #restore(root: string, id: string, base: Timeline): Promise<void> {
    const key = await this.#key(root, id);
    // Known text only when it is `base`'s: a broken file's text is no version to restore.
    const known = this.#known.get(key);
    const restored = known?.timeline === base ? known.text : `${JSON.stringify(base, null, 2)}\n`;
    await writeTextAtomic(timelinePath(root, id), restored);
    this.#known.set(key, { text: restored, timeline: base });
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

function newOpId(): string {
  return `op_${randomBytes(4).toString("hex")}`;
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

/** TimelineNotFound for timeline `id` of `root`, listing the timelines there are. */
async function timelineNotFound(root: string, id: string): Promise<RpcError> {
  const available = await listTimelines(root);
  return new RpcError(
    ErrorCode.TimelineNotFound,
    `No timeline "${id}" (${timelineRel(id)}) in ${root}` + (available.length > 0 ? `; timelines: ${available.join(", ")}.` : "."),
    { timeline: id, path: timelineRel(id), available },
  );
}

/** Timeline file content, JSON syntax and schema checked. */
function parseText(text: string): ParseResult<Timeline> {
  try {
    return parseTimeline(JSON.parse(text));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Timeline file content `text` of `path`, parsed; InvalidProjectFile otherwise. */
function parseIncoming(path: string, text: string): Timeline {
  const parsed = parseText(text);
  if (!parsed.ok) throw invalidFile(path, parsed.error);
  return parsed.value;
}

/** `incoming` when it carries `base`'s revision; StaleRevision otherwise. */
function checkRevision(id: string, path: string, incoming: Timeline, base: Timeline): Timeline {
  if (incoming.revision === base.revision) return incoming;
  throw new RpcError(
    ErrorCode.StaleRevision,
    `${timelineRel(id)} was edited at revision ${incoming.revision}, but timeline ${id} is at revision ${base.revision}` +
      `${incoming.revision < base.revision ? " (it changed since that copy was read)" : ""}. ` +
      "Re-read the file, reapply the edit keeping its `revision`, and save again.",
    { path, timeline: id, revision: incoming.revision, current: base.revision },
  );
}

/** ProposalPending for a change refused because `proposal` is open (ADR 0019). */
function proposalPending(proposal: OpenProposal): RpcError {
  const what = proposal.label ? `${proposal.tx}, "${proposal.label}"` : proposal.tx;
  return new RpcError(ErrorCode.ProposalPending, `A proposal is waiting for review (${what}). Run \`frameshell proposal wait\`, then continue.`, {
    tx: proposal.tx,
    label: proposal.label,
    author: proposal.author,
    state: proposal.state,
    hint: "`frameshell proposal wait` (MCP: `proposal_wait`), then retry.",
  });
}

/** ProposalState for proposal `tx`; see `ErrorCode.ProposalState` for the reasons. */
function proposalState(tx: string, reason: string, message: string, conflicts: string[] = []): RpcError {
  const hints: Record<string, string> = {
    forbidden: "Only the person decides, in the Frameshell app.",
    building: "Wait until its transaction closes (`tx commit`).",
    stale: "Re-read the timeline and redo the change.",
    rejected: "Ask the person what to change.",
  };
  return new RpcError(ErrorCode.ProposalState, message, { tx, reason, conflicts, hint: hints[reason] ?? "`frameshell proposal status`." });
}

/** ProposalState telling an author its building proposal closed unapplied. */
function closedError(notice: { tx: string; reason: "stale" | "rejected"; conflicts: string[] }): RpcError {
  const { tx, reason, conflicts } = notice;
  if (reason === "rejected") {
    return proposalState(tx, "rejected", `Your proposal ${tx} was rejected in the app while you were building it. Nothing of it was applied. Ask the person what to change.`);
  }
  const ids = conflicts.join(", ") || "the same timeline";
  return proposalState(tx, "stale", `Your proposal ${tx} went stale: the person changed ${ids} meanwhile. Nothing of it was applied. Re-read the timeline and redo the change.`, conflicts);
}

/**
 * `part`'s operations as journal entries of `proposal`'s transaction, chained
 * from its base, and the timeline they end at: what `planDiff` rewinds.
 */
function proposedEntries(part: ProposalPart, proposal: OpenProposal): { state: Timeline; entries: JournalEntry[] } {
  let state = part.base;
  const entries: JournalEntry[] = [];
  for (const op of part.ops) {
    const next = { ...applyPatch(state, op.patch), revision: state.revision + 1 };
    entries.push({
      id: op.id,
      op: op.op,
      args: op.args,
      inverse: op.inverse,
      author: proposal.author,
      tx: proposal.tx,
      revisionBefore: state.revision,
      txLabel: proposal.label,
      at: op.at,
      revision: next.revision,
      hashBefore: timelineHash(state),
      hash: timelineHash(next),
    });
    state = next;
  }
  return { state, entries };
}

/** Operations of `proposal`, every timeline; a timeline it adds counts as one. */
function operationCount(proposal: OpenProposal): number {
  return proposal.parts.reduce((sum, part) => sum + part.ops.length, 0) + (proposal.files?.length ?? 0);
}

/** Timelines `proposal` changes or adds. */
function proposalTimelines(proposal: OpenProposal): string[] {
  return [...proposal.parts.map((part) => part.timeline), ...(proposal.files ?? []).map((file) => file.timeline)];
}

/** The file `proposal` keeps for timeline `id`, which it adds; undefined when none. */
function proposedFile(proposal: OpenProposal, id: string): ProposedFile | undefined {
  return proposal.files?.find((file) => file.timeline === id);
}

/** TimelineNotFound for an operation on timeline `id`, which only `proposal` holds so far. */
function keptAside(proposal: OpenProposal, id: string): RpcError {
  return new RpcError(
    ErrorCode.TimelineNotFound,
    `${timelineRel(id)} is new in proposal ${proposal.tx}, which waits for review: it becomes a timeline once accepted. ` +
      "Rewrite the whole file with `file.write`, or run operations on it after `frameshell proposal wait`.",
    { timeline: id, path: timelineRel(id), available: [] },
  );
}

/** TimelineNotFound or InvalidProjectFile: no readable version of the file. */
function unreadable(error: unknown): boolean {
  return error instanceof RpcError && (error.code === ErrorCode.TimelineNotFound || error.code === ErrorCode.InvalidProjectFile);
}

function newTxId(): string {
  return `tx_${randomBytes(4).toString("hex")}`;
}

/** `proposal` as `status` and `proposal.status` list it. */
function summary(proposal: OpenProposal): Proposal {
  return {
    tx: proposal.tx,
    label: proposal.label,
    author: proposal.author,
    state: proposal.state,
    operations: operationCount(proposal),
    timelines: proposalTimelines(proposal),
    openedAt: proposal.openedAt,
    ageMs: Math.max(0, Date.now() - Date.parse(proposal.openedAt)),
  };
}

/** `proposal.wait` result for a closed proposal. */
function waitOutcome(decision: ProposalDecision): ProposalWaitResult {
  const { outcome, tx, label, author, conflicts } = decision;
  return { outcome, tx, label, author, conflicts, proposal: null };
}

function invalidFile(path: string, details: string): RpcError {
  return new RpcError(
    ErrorCode.InvalidProjectFile,
    `Invalid ${path}:\n${details}\nFix the file (or restore it from version control) and retry.`,
    { path, details },
  );
}

/** Parse a project-relative timeline file. Throws TimelineNotFound (missing) or InvalidProjectFile. */
export async function readTimelineFile(root: string, rel: string): Promise<Timeline> {
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

/**
 * Resolve a caller's path (absolute, else relative to `cwd`, then to `root`) to a
 * project-relative `/` path, preferring an existing file. Throws InvalidOperation
 * "outside project" (naming `field` and `op`) when it leaves the project or
 * points under `.frameshell/`.
 */
export function projectPath(root: string, cwd: string, path: string, field: string, op = "clip.add"): string {
  const candidates = isAbsolute(path) ? [path] : [resolve(cwd, path), resolve(root, path)];
  const inside = candidates
    .map((candidate) => relative(root, candidate))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
  const chosen = inside.find((rel) => isFile(join(root, rel))) ?? inside[0];
  if (chosen === undefined || chosen.split(sep)[0]?.toLowerCase() === ".frameshell") {
    throw new RpcError(ErrorCode.InvalidOperation, `${field} ${path} is outside the project ${root}. Import it first: \`frameshell import <file>\`.`, {
      op,
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
    elementStyles: adapter.elementStyles === true,
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
