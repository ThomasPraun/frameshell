// Review mode state (ADR 0019): pure, so the bar's behaviour is unit tested.
import type { ProposalStatusResult, TimelineViewName } from "@frameshell/protocol";
import type { ProposalChange, ReviewEvent } from "../../../shared/api.js";
import { authorOf } from "../history/model.js";

/** Which version of the timeline the window shows while a proposal is open. */
export type ReviewSide = "before" | "after";

/** The open proposal, as the bar needs it. */
export interface OpenProposal {
  tx: string;
  label: string | null;
  author: string;
  state: "building" | "ready";
  operations: number;
  timelines: readonly string[];
}

/** A proposal that went stale: kept until dismissed, since nothing else tells the person why it vanished. */
export interface StaleNotice {
  tx: string;
  label: string | null;
  author: string;
  /** Ids of the clips, tracks or groups both the person and the proposal changed. */
  conflicts: readonly string[];
}

/** Everything the window knows about review mode. */
export interface ReviewState {
  /** The project's switch. */
  enabled: boolean;
  proposal: OpenProposal | null;
  stale: StaleNotice | null;
  side: ReviewSide;
  /** Counts proposal steps, so readers of the proposal's version know when to read again. */
  version: number;
}

/** Before the first read: review off, nothing open. */
export const INITIAL_REVIEW: ReviewState = { enabled: false, proposal: null, stale: null, side: "before", version: 0 };

/** The bar is on After when a proposal first becomes ready, or is found ready. */
function sideFor(previous: OpenProposal | null, next: OpenProposal, side: ReviewSide): ReviewSide {
  if (next.state === "ready" && (previous?.tx !== next.tx || previous.state !== "ready")) return "after";
  return previous?.tx === next.tx ? side : "before";
}

function proposalOf(open: Omit<OpenProposal, "timelines"> & { timelines: readonly string[] }): OpenProposal {
  const { tx, label, author, state, operations, timelines } = open;
  return { tx, label, author, state, operations, timelines };
}

/** State after reading `proposal.status`. */
export function readStatus(state: ReviewState, status: Pick<ProposalStatusResult, "enabled" | "proposal">): ReviewState {
  const proposal = status.proposal ? proposalOf(status.proposal) : null;
  return {
    ...state,
    enabled: status.enabled,
    proposal,
    stale: proposal ? null : state.stale,
    side: proposal ? sideFor(state.proposal, proposal, state.side) : "before",
    version: state.version + 1,
  };
}

/** State after one {@link ReviewEvent}. `resync` changes nothing: the caller reads the status again. */
export function applyEvent(state: ReviewState, event: ReviewEvent): ReviewState {
  if ("enabled" in event) return { ...state, enabled: event.enabled };
  if ("resync" in event) return state;
  const change: ProposalChange = event.proposal;
  const version = state.version + 1;
  if (change.state === "building" || change.state === "ready") {
    const proposal = proposalOf({ ...change, state: change.state });
    return { ...state, proposal, stale: null, side: sideFor(state.proposal, proposal, state.side), version };
  }
  // Closed: only the open proposal's own closing matters.
  if (state.proposal && state.proposal.tx !== change.tx) return state;
  const stale =
    change.state === "stale" ? { tx: change.tx, label: change.label, author: change.author, conflicts: change.conflicts } : state.stale;
  return { ...state, proposal: null, stale, side: "before", version };
}

/** Show `side`; only meaningful while a proposal is open. */
export function withSide(state: ReviewState, side: ReviewSide): ReviewState {
  return state.proposal && state.side !== side ? { ...state, side } : state;
}

/** The person edited while looking at After: edits apply to the file, so the view returns to Before. */
export function afterEdit(state: ReviewState): ReviewState {
  return state.side === "after" ? { ...state, side: "before" } : state;
}

/** The dismissed stale notice goes away. */
export function dismissStale(state: ReviewState): ReviewState {
  return state.stale ? { ...state, stale: null } : state;
}

/** `view` to ask `timeline.show` and the other reads for: the proposal's version only on After. */
export function viewOf(state: ReviewState): TimelineViewName | undefined {
  return state.proposal && state.side === "after" ? "proposal" : undefined;
}

/** What the proposal bar shows; null: no bar. */
export type BarModel =
  | { kind: "building" | "ready"; proposal: OpenProposal; side: ReviewSide }
  | { kind: "stale"; notice: StaleNotice };

/** The bar for `state`: the open proposal wins over a stale notice. */
export function barOf(state: ReviewState): BarModel | null {
  if (state.proposal) return { kind: state.proposal.state, proposal: state.proposal, side: state.side };
  if (state.stale) return { kind: "stale", notice: state.stale };
  return null;
}

/** Who made a proposal, in a word: an agent's own label (`claude`), else History's name for the author. */
export function whoOf(author: string): string {
  const agent = /^agent:([^:]+)/.exec(author);
  return agent ? agent[1]! : authorOf(author).name;
}
