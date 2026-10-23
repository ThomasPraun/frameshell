import { z } from "zod";
import { AuthorSchema, TxIdSchema } from "./timeline.js";

/**
 * Review mode (ADR 0019): while a project's switch is on, a timeline change
 * by any author but `ui` waits as a proposal, accepted or rejected whole.
 */

/**
 * Where a proposal stands. Open: `building`, `ready`. Closed: `accepted`,
 * `rejected`, `stale`, `aborted`.
 */
export const ProposalStateSchema = z
  .enum(["building", "ready", "accepted", "rejected", "stale", "aborted"])
  .describe(
    "`building`: its transaction is still open and its author keeps adding operations. `ready`: the transaction closed; " +
      "it waits for the person to accept or reject it. `accepted`: its operations were applied and journaled. " +
      "`rejected`: the person refused it; nothing was applied. `stale`: the person changed the same clips, tracks or " +
      "groups meanwhile (or a replay on their edit broke a timeline rule); nothing was applied. `aborted`: its author " +
      "ran `tx abort` while it was building.",
  );

/** See {@link ProposalStateSchema}. */
export type ProposalState = z.output<typeof ProposalStateSchema>;

/** How a closed proposal ended. */
export const ProposalOutcomeSchema = z.enum(["accepted", "rejected", "stale", "aborted"]);

/** See {@link ProposalOutcomeSchema}. */
export type ProposalOutcome = z.output<typeof ProposalOutcomeSchema>;

/** The open proposal of a project. */
export const ProposalSchema = z.object({
  tx: TxIdSchema.describe("Proposal id: the id of the transaction it holds."),
  label: z.string().nullable().describe("Label from `tx begin`; null for automatic grouping. Direct file edits: `Edit timelines/<id>.json`."),
  author: AuthorSchema,
  state: z.enum(["building", "ready"]).describe("`building` while its transaction is open; `ready` once it waits for review."),
  operations: z.int().describe("Operations it holds, every timeline."),
  timelines: z.array(z.string()).describe("Ids of the timelines it changes, in the order it first changed them."),
  openedAt: z.string().describe("ISO 8601 time of its first operation."),
  ageMs: z.number().describe("Milliseconds since `openedAt`."),
});

/** See {@link ProposalSchema}. */
export type Proposal = z.output<typeof ProposalSchema>;

/** One closed proposal, as `.frameshell/proposals/decisions.jsonl` keeps it. */
export const ProposalDecisionSchema = z.object({
  tx: TxIdSchema,
  label: z.string().nullable(),
  author: AuthorSchema,
  outcome: ProposalOutcomeSchema,
  timelines: z.array(z.string()).describe("Ids of the timelines it changed."),
  conflicts: z
    .array(z.string())
    .describe("`stale`: ids of the clips, tracks or groups both the person and the proposal changed (`order` = track order). Empty otherwise."),
  at: z.string().describe("ISO 8601 time of the decision."),
});

/** See {@link ProposalDecisionSchema}. */
export type ProposalDecision = z.output<typeof ProposalDecisionSchema>;

/** Review mode of a project now: the switch, the open proposal, recent decisions. */
export const ReviewStateSchema = z.object({
  enabled: z
    .boolean()
    .describe("Review mode switch, set by the person in the app. While on, every timeline change not made in the app waits as a proposal."),
  proposal: ProposalSchema.nullable().describe("The open proposal; null when none. At most one per project."),
  decisions: z.array(ProposalDecisionSchema).describe("Last closed proposals, newest first, at most 10."),
});

/** See {@link ReviewStateSchema}. */
export type ReviewState = z.output<typeof ReviewStateSchema>;

/** Which timeline a read shows while a proposal is open. */
export const TimelineViewNameSchema = z
  .enum(["current", "proposal"])
  .describe(
    "`current`: the timeline file as it is. `proposal`: the file plus the open proposal's changes (the same as " +
      "`current` when no proposal changes this timeline). Default: `proposal` for the proposal's author, `current` " +
      "for everyone else.",
  );

/** See {@link TimelineViewNameSchema}. */
export type TimelineViewName = z.output<typeof TimelineViewNameSchema>;

/** Fields every read taking `view` adds to its result. */
export const ViewedShape = {
  view: TimelineViewNameSchema.describe("Which timeline this result shows."),
  proposal: z
    .object({ tx: TxIdSchema, state: z.enum(["building", "ready"]) })
    .nullable()
    .describe("The project's open proposal; null when none."),
};
