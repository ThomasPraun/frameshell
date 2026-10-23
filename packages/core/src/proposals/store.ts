import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthorSchema,
  type GcEntry,
  OpIdSchema,
  type ProposalDecision,
  ProposalDecisionSchema,
  ProposalStateSchema,
  type TimelinePatch,
  TimelinePatchSchema,
  TxIdSchema,
} from "@frameshell/protocol";
import { type Timeline, parseTimeline } from "@frameshell/schema";
import { z } from "zod";
import { appendJsonLine, readJsonIfExists, readJsonLines, writeJsonAtomic } from "../fs-util.js";
import { sweep } from "../gc.js";

/**
 * Durable side of review mode (ADR 0019): `.frameshell/proposals/<tx>.json`
 * per proposal, written before each of its operations answers, so an open
 * one survives a daemon restart; `decisions.jsonl` logs every outcome.
 * Nothing here is needed to open a project.
 */

/** Project-relative directory of proposal files and the decision log. */
export const PROPOSALS_DIR = ".frameshell/proposals";

/** Closed proposals are kept this long for recovery, then swept by `gc`. */
export const PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** One operation of a proposal: what the journal will hold once accepted, plus the patch that replays it. */
export interface ProposedOp {
  id: string;
  op: string;
  args: Record<string, unknown>;
  /** Turns the timeline before the operation into the one after it; replayed on rebase and accept. */
  patch: TimelinePatch;
  inverse: { op: "timeline.patch"; args: TimelinePatch };
  /** ISO 8601 time the operation was proposed. */
  at: string;
}

/** What a proposal does to one timeline. */
export interface ProposalPart {
  timeline: string;
  /** The current timeline the operations apply to (the file, as of the last rebase). */
  base: Timeline;
  /** `base` with every operation applied: what the proposal's author reads. Not stored. */
  shadow: Timeline;
  ops: ProposedOp[];
}

/**
 * A timeline file the proposal adds, or writes over an unreadable one: kept
 * here, not in `timelines/`, until accepted.
 */
export interface ProposedFile {
  timeline: string;
  /** The whole file content, valid against the timeline schema. */
  text: string;
}

/** The open proposal of a project. */
export interface OpenProposal {
  tx: string;
  label: string | null;
  author: string;
  state: "building" | "ready";
  openedAt: string;
  parts: ProposalPart[];
  /** Direct file edit turned proposal: the edited file text, kept for recovery. */
  edit?: { timeline: string; text: string } | undefined;
  /** Timelines it creates (or replaces while unreadable); never also in `parts`. */
  files?: ProposedFile[] | undefined;
}

const ProposedOpSchema = z.object({
  id: OpIdSchema,
  op: z.string(),
  args: z.record(z.string(), z.unknown()),
  patch: TimelinePatchSchema,
  inverse: z.object({ op: z.literal("timeline.patch"), args: TimelinePatchSchema }),
  at: z.string(),
});

const ProposalFileSchema = z.object({
  version: z.literal(1),
  tx: TxIdSchema,
  label: z.string().nullable(),
  author: AuthorSchema,
  state: ProposalStateSchema,
  openedAt: z.string(),
  decidedAt: z.string().optional(),
  conflicts: z.array(z.string()).optional(),
  timelines: z.array(z.object({ timeline: z.string(), base: z.unknown(), ops: z.array(ProposedOpSchema) })),
  edit: z.object({ timeline: z.string(), text: z.string() }).optional(),
  files: z.array(z.object({ timeline: z.string(), text: z.string() })).optional(),
});

/** A proposal file read back: an open proposal without shadows. */
export type StoredProposal = Omit<OpenProposal, "parts"> & { parts: Omit<ProposalPart, "shadow">[] };

function proposalPath(root: string, tx: string): string {
  return join(root, ...PROPOSALS_DIR.split("/"), `${tx}.json`);
}

function decisionsPath(root: string): string {
  return join(root, ...PROPOSALS_DIR.split("/"), "decisions.jsonl");
}

/** Write `proposal`'s file; `closed` marks it decided (kept for recovery, see {@link sweepProposals}). */
export async function saveProposal(
  root: string,
  proposal: OpenProposal,
  closed?: { state: "rejected" | "stale" | "aborted"; at: string; conflicts: string[] },
): Promise<void> {
  const file: z.input<typeof ProposalFileSchema> = {
    version: 1,
    tx: proposal.tx,
    label: proposal.label,
    author: proposal.author,
    state: closed?.state ?? proposal.state,
    openedAt: proposal.openedAt,
    ...(closed ? { decidedAt: closed.at, conflicts: closed.conflicts } : {}),
    timelines: proposal.parts.map(({ timeline, base, ops }) => ({ timeline, base, ops })),
    ...(proposal.edit ? { edit: proposal.edit } : {}),
    ...(proposal.files?.length ? { files: proposal.files } : {}),
  };
  await writeJsonAtomic(proposalPath(root, proposal.tx), file);
}

/** Delete `tx`'s proposal file (accepted: its operations are in the journals now). */
export async function removeProposal(root: string, tx: string): Promise<void> {
  await rm(proposalPath(root, tx), { force: true });
}

/** Open (building or ready) proposals on disk, oldest first. Unreadable files are skipped. */
export async function loadOpenProposals(root: string): Promise<StoredProposal[]> {
  const names = await readdir(join(root, ...PROPOSALS_DIR.split("/"))).catch(() => [] as string[]);
  const found: StoredProposal[] = [];
  for (const name of names) {
    if (!PROPOSAL_FILE.test(name)) continue;
    let value: unknown;
    try {
      value = await readJsonIfExists(join(root, ...PROPOSALS_DIR.split("/"), name));
    } catch {
      continue;
    }
    const parsed = ProposalFileSchema.safeParse(value);
    if (!parsed.success) continue;
    const { state, timelines, edit, files, tx, label, author, openedAt } = parsed.data;
    if (state !== "building" && state !== "ready") continue;
    const parts: StoredProposal["parts"] = [];
    for (const part of timelines) {
      const base = parseTimeline(part.base);
      if (!base.ok) break;
      parts.push({ timeline: part.timeline, base: base.value, ops: part.ops });
    }
    if (parts.length !== timelines.length) continue;
    found.push({ tx, label, author, state, openedAt, parts, ...(edit ? { edit } : {}), ...(files ? { files } : {}) });
  }
  return found.sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));
}

/** Append one outcome to the decision log. */
export async function appendDecision(root: string, decision: ProposalDecision): Promise<void> {
  await appendJsonLine(decisionsPath(root), decision);
}

/** Every logged decision, oldest first; unreadable lines are skipped. */
export async function readDecisions(root: string): Promise<ProposalDecision[]> {
  const decisions: ProposalDecision[] = [];
  for (const value of await readJsonLines(decisionsPath(root))) {
    const parsed = ProposalDecisionSchema.safeParse(value);
    if (parsed.success) decisions.push(parsed.data);
  }
  return decisions;
}

const PROPOSAL_FILE = /^tx_[0-9a-f]{8}\.json$/;

/**
 * `gc` of closed proposal files older than {@link PROPOSAL_MAX_AGE_MS} (by
 * modification time, which is their decision time). `open` is the open
 * proposal's id, never swept; the decision log stays.
 */
export function sweepProposals(root: string, options: { dryRun: boolean; open: string | null; now?: () => number }): Promise<GcEntry[]> {
  const now = options.now ?? Date.now;
  return sweep({
    root,
    dir: PROPOSALS_DIR,
    classify: (name, isDirectory) => (!isDirectory && PROPOSAL_FILE.test(name) ? { kind: "proposal", key: name.slice(0, -".json".length) } : null),
    keep: (tx) => tx === options.open,
    keepNewerThan: now() - PROPOSAL_MAX_AGE_MS,
    temps: false,
    dryRun: options.dryRun,
    now,
  });
}
