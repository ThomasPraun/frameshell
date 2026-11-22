import { z } from "zod";
import { ProposalConfigChangeSchema } from "../config.js";
import {
  ConfigOperationSchema,
  HistoryDiffResultSchema,
  HistorySoundResultSchema,
  HistoryResultSchema,
  TransactionInfoSchema,
} from "../history.js";
import { ProposalOutcomeSchema, ProposalSchema, ProposalStateSchema, ReviewStateSchema } from "../proposals.js";
import { OpIdSchema, OperationResultSchema, TimelineIdSchema, TxIdSchema } from "../timeline.js";
import { type MethodSpec, CwdParam, PROPOSAL_WAIT_DEFAULT_S, PROPOSAL_WAIT_MAX_S } from "./shared.js";

/** Daemon methods: transactions, history, revert and review-mode proposals. */
export const historyMethods = {
  "tx.begin": {
    mutating: true,
    description:
      "Start an explicit transaction for this terminal session: every following operation (any timeline) joins it until " +
      "`tx.commit` or `tx.abort`, so `history` lists them under `label` and `revert` can undo them as one. Without it, " +
      "operations from one session are grouped automatically until an idle gap. The transaction is stored on disk and " +
      "survives a daemon restart. Needs a session: app terminals set `FRAMESHELL_SESSION`, elsewhere the CLI generates " +
      "one per shell. Example: `{ label: \"remove silences\" }`. Pass `autoCommitAfter` when a crash of the caller must " +
      "not leave the transaction open: it is then committed automatically once that many seconds pass without an " +
      "operation of this author. Fails with TransactionState when one is already open, and with ProposalPending while " +
      "a review-mode proposal waits (ADR 0019) in the project enclosing `cwd` (without `cwd`: in any open project): run " +
      "`proposal.wait`, then begin. With review mode on, the label is what the person reads when reviewing: give one " +
      "intent one transaction.",
    params: z.strictObject({
      cwd: CwdParam.optional().describe(
        "Absolute directory inside the project the transaction works on, e.g. `/home/ana/videos/launch`; only that " +
          "project's review-mode proposal refuses it. Omitted: a proposal in any open project does.",
      ),
      label: z.string().min(1).describe("What the transaction does, shown in the History panel, e.g. `remove silences`."),
      autoCommitAfter: z
        .number()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "Seconds without an operation of this author after which the daemon commits the transaction itself, e.g. `15`. " +
            "Default: stays open until `tx.commit` or `tx.abort`.",
        ),
    }),
    result: TransactionInfoSchema,
  },
  "tx.commit": {
    mutating: true,
    description:
      "Close this session's explicit transaction, keeping its changes. `operations` counts them across timelines. " +
      "In review mode its operations now wait for review as one proposal (`proposal`): call `proposal.wait`. " +
      "Fails with TransactionState when none is open.",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      operations: z.int().describe("Operations applied in the transaction."),
      proposal: z
        .object({ tx: z.string(), state: ProposalStateSchema })
        .nullable()
        .describe("Review mode (ADR 0019): the proposal holding the transaction's operations, now `ready`; null when they were applied."),
    }),
  },
  "tx.abort": {
    mutating: true,
    description:
      "Close this session's explicit transaction and undo its changes: on every timeline it touched, its operations' " +
      "inverses are applied newest first as one `revert` operation inside the transaction. All or nothing: every " +
      "timeline is checked first, and when someone else changed the same tracks or clips since on any of them, nothing " +
      "is undone and it fails with RevertConflict listing each conflicting timeline in `timelines` (transaction stays " +
      "open). In review mode, a proposal still building from it is dropped: nothing of it reached the file. Operations " +
      "that did reach the file (applied before review mode was turned on) are not undone at once: the undo waits for " +
      "review as a new proposal (`proposal`, labelled `Abort \"<label>\"`); call `proposal.wait`. Its project-config " +
      "changes (`format.add`/`format.remove`, ADR 0036) are undone too, checked before anything is undone; while review " +
      "mode is on only the person may abort a transaction that changed config (ProposalState `forbidden`). Fails with " +
      "TransactionState when none is open, ProposalPending when another proposal waits (transaction stays open).",
    params: z.strictObject({}),
    result: TransactionInfoSchema.extend({
      reverted: z.array(OperationResultSchema).describe("One `revert` operation per timeline the transaction changed and this undid."),
      config: z.array(ConfigOperationSchema).describe("One config `revert` operation per config document it changed and this undid (ADR 0036)."),
      proposal: z
        .object({ tx: z.string(), state: ProposalStateSchema })
        .nullable()
        .describe("Review mode (ADR 0019): the `ready` proposal holding the undo; null when it was applied or nothing reached the file."),
    }),
  },
  history: {
    description:
      "List a timeline's journaled operations grouped by transaction, oldest first: op, args, author (`ui`, " +
      "`cli:<session>`, `agent:<label>:<session>`, `file`, `plugin:<name>`), revisions and touched ids. Project-config " +
      "operations (`format.add`/`format.remove`, ADR 0036) are listed in every timeline's history, in their transaction, " +
      "with `doc` set and their keys (e.g. `format:9x16`) as `touched`. Pass `since` with your last transaction id " +
      "to see only what happened after it, e.g. what the human changed in the app. Fails with HistoryNotFound when " +
      "`since` is in neither this timeline's journal nor the config journal.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      since: TxIdSchema.optional().describe("Only operations journaled after this transaction's last operation."),
    }),
    result: HistoryResultSchema,
  },
  "history.diff": {
    description:
      "What a transaction (`tx_…`) or a single operation (`op_…`) did to a timeline's clips: each clip it added, removed, " +
      "moved (other track or start, same length) or otherwise changed (trim, speed, gain, props), with its track, start " +
      "and end right before and right after the target. Later operations do not change the answer. Use it to see what " +
      "a transaction from `history` changed before you `revert` it. A target only in the project-config journal " +
      "(`format.add`/`format.remove`, ADR 0036) changed no clips: `clips` is empty. Fails with HistoryNotFound when the " +
      "id is in neither journal, or changed only other timelines (`data.timelines` names them), HistoryUnavailable when the file changed outside the journal after the target.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to diff."),
    }),
    result: HistoryDiffResultSchema,
  },
  "history.sound": {
    description:
      "What a transaction (`tx_…`) or a single operation (`op_…`) did to a timeline's sound, per track: each track whose " +
      "level moved by 1 dB or more, with the time ranges, whether the sound came in, went or changed level, and by how " +
      "many dB. Use it after a sound edit (a duck, a gain, a music move, an effect placed) to prove it touched only the " +
      "tracks and times you meant. Compares the timeline right before and right after the target; later operations do " +
      "not change the answer. Nothing is mixed: each clip is read from its asset's 10 ms envelope with its gain, keys " +
      "and fades, so it is measured, never heard. Times are the timeline's: a change that also moved clips shows as " +
      "sound removed in one place and added in another. A config-only target changed no sound: `tracks` is empty. " +
      "Fails like `history.diff`.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to compare around."),
    }),
    result: HistorySoundResultSchema,
  },
  revert: {
    mutating: true,
    description:
      "Undo a transaction (`tx_…`) or a single operation (`op_…`) on one timeline by applying the stored inverses, " +
      "newest first, as a new `revert` operation (history stays append-only; reverting a revert redoes). Refused with " +
      "RevertConflict listing the later operations that changed the same tracks or clips: revert those first, newest " +
      "first. Also refused, with empty `conflicts`, when the file changed outside the journal after the target (e.g. " +
      "edited while the daemon was not running): the journal cannot undo what it did not record, so edit forward. " +
      "Project-config operations (`format.add`/`format.remove`, ADR 0036) revert too: by their `op`, or with the `tx` " +
      "that holds them, which undoes its timeline and config operations together; a later change of the same format " +
      "conflicts like a clip (`ids` holds keys such as `format:9x16`), and a hand edit of `formats` in `frameshell.json` " +
      "refuses like a hand edit of the timeline. When only config was reverted, `operation` is the config `revert` with " +
      "an empty inverse and `revision` is unchanged; `config` lists the config `revert` operations. While review mode " +
      "is on, only the person may revert config (ProposalState `forbidden` for others). A transaction that changed " +
      "several timelines reverts one timeline per call: its config goes with the first, later calls skip it. Fails " +
      "with HistoryNotFound when the id is in neither the timeline's journal nor the config journal, or changed only " +
      "other timelines (`data.timelines` names them: pass one as `timeline`).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to undo."),
    }),
    result: OperationResultSchema.extend({
      config: z.array(ConfigOperationSchema).describe("Config `revert` operations it journaled (ADR 0036); empty when the target held none."),
    }),
  },
  "review.set": {
    mutating: true,
    internal: true,
    description:
      "Turn review mode (ADR 0019) on or off for the project enclosing `cwd`, stored per user in `<configDir>/review.json`. " +
      "Only the app (author `ui`) may; anyone else gets ProposalState (reason `forbidden`). Turning it off leaves an " +
      "open proposal to be decided.",
    params: z.strictObject({
      cwd: CwdParam,
      enabled: z.boolean().describe("True: changes not made in the app wait as proposals."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      enabled: z.boolean(),
    }),
  },
  "proposal.status": {
    description:
      "Review mode (ADR 0019) of the project: whether the person turned it on, the open proposal (author, label, state, " +
      "operations, timelines, age) and the last decisions. While review mode is on, your timeline and format changes do not touch " +
      "the file: they wait as one proposal per transaction until the person accepts or rejects it in the app. Your own " +
      "reads show the proposal's version (`view: \"proposal\"`).",
    params: z.strictObject({ cwd: CwdParam }),
    result: ReviewStateSchema.extend({ dir: z.string().describe("Project root.") }),
  },
  "proposal.wait": {
    description:
      "Block until the project's open review-mode proposal (ADR 0019) is decided, then say how: `accepted` (applied, " +
      "continue), `rejected` (ask the person what to change), `stale` (the person changed the same clips: re-read the " +
      "timeline and redo; `conflicts` names the ids) or `aborted`. After `timeout` seconds it returns `pending`: call " +
      "it again. With no open proposal it returns the last decision at once, or `none`. Call it after a change fails " +
      "with ProposalPending, or after your transaction closes in review mode.",
    params: z.strictObject({
      cwd: CwdParam,
      timeout: z
        .number()
        .positive()
        .max(PROPOSAL_WAIT_MAX_S)
        .optional()
        .describe(`Seconds to wait at most, e.g. \`120\`. Default ${PROPOSAL_WAIT_DEFAULT_S}, max ${PROPOSAL_WAIT_MAX_S}.`),
    }),
    result: z.object({
      outcome: z
        .enum([...ProposalOutcomeSchema.options, "pending", "none"])
        .describe("How the proposal ended; `pending`: still open after `timeout`; `none`: no proposal now or before."),
      tx: z.string().nullable().describe("The proposal's id; null for `none`."),
      label: z.string().nullable(),
      author: z.string().nullable(),
      conflicts: z.array(z.string()).describe("`stale`: ids both you and the person changed. Empty otherwise."),
      proposal: ProposalSchema.nullable().describe("`pending`: the proposal still open. Null otherwise."),
    }),
  },
  "proposal.diff": {
    description:
      "What the open review-mode proposal (ADR 0019) changes, per timeline, from the file to the proposal's version: " +
      "each clip it adds, removes, moves (other track or start, same length) or otherwise changes, with its track, " +
      "start and end before and after, in the shape of `history.diff` (the marks the app shows on the timeline). " +
      "`config` lists the project-config keys it changes (ADR 0036), e.g. `format:9x16`. " +
      "Without `tx` the open proposal; `timelines` and `config` are empty and `tx` null when none is open. Fails with ProposalState " +
      "(`decided` or `unknown`) when `tx` is not the open proposal.",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.optional().describe("The proposal's id. Default: the open proposal.") }),
    result: z.object({
      tx: z.string().nullable().describe("The proposal diffed; null when none is open."),
      timelines: z.array(HistoryDiffResultSchema).describe("One per timeline the proposal changes, `target` = its id; in the order it first changed them."),
      config: z
        .array(ProposalConfigChangeSchema)
        .describe("Every config key it changes, with the file's value (`before`) and the proposal's (`after`); null = absent."),
    }),
  },
  "proposal.accept": {
    mutating: true,
    internal: true,
    description:
      "Apply the ready proposal `tx` (ADR 0019): its operations are journaled in order under their author, transaction " +
      "and label, each marked `proposal: <tx>`, on every timeline and config document or none (config is written first). " +
      "Only the app (author `ui`) may. Fails with " +
      "ProposalState: `forbidden` (not `ui`), `building` (not ready), `decided`/`unknown` (not the open proposal), or " +
      "`stale` (the person's edit overlaps it; it is closed as stale).",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.describe("The proposal's id.") }),
    result: z.object({
      tx: z.string(),
      operations: z.array(OperationResultSchema).describe("The journaled timeline operations, in order."),
      config: z.array(ConfigOperationSchema).describe("The journaled config operations (ADR 0036), in order; empty when none."),
    }),
  },
  "proposal.reject": {
    mutating: true,
    internal: true,
    description:
      "Refuse the open proposal `tx` (ADR 0019), ready or still building: nothing is journaled; its file stays in " +
      "`.frameshell/proposals/` for 7 days. Only the app (author `ui`) may. Fails with ProposalState: `forbidden`, " +
      "`decided` or `unknown`.",
    params: z.strictObject({ cwd: CwdParam, tx: TxIdSchema.describe("The proposal's id.") }),
    result: z.object({ tx: z.string() }),
  },
} as const satisfies Record<string, MethodSpec>;
