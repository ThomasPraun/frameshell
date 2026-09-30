import { z } from "zod";
import { AuthorSchema, OpIdSchema, OperationRecordSchema, TxIdSchema } from "./timeline.js";

/**
 * History and transactions (SPEC §6.2): the journal line format of
 * `.frameshell/history/<timeline>.jsonl` and the results of `history`,
 * `tx.*` and `revert`.
 */

/**
 * One journal line: the operation record plus where it sits in history.
 * The journal is append-only; a revert is a new line with op `revert`.
 */
export const JournalEntrySchema = OperationRecordSchema.extend({
  txLabel: z.string().nullable().describe("Label given to `tx.begin`; null for automatic transactions."),
  at: z.string().describe("ISO 8601 time the operation was applied."),
  revision: z.int().describe("Timeline revision after the operation."),
  hashBefore: z
    .string()
    .describe("Content hash of the timeline the operation was applied to; must equal the previous entry's `hash`, else the file changed outside the journal."),
  hash: z.string().describe("Content hash of the timeline the operation wrote. `revert` compares it to the file."),
});

/** See {@link JournalEntrySchema}. */
export type JournalEntry = z.output<typeof JournalEntrySchema>;

/** One operation as `history` lists it: the journal line without its inverse, plus the ids it touched. */
export const HistoryOperationSchema = z.object({
  id: OpIdSchema,
  op: z.string().describe("Operation name, e.g. `clip.trim`, or `revert`."),
  args: z.record(z.string(), z.unknown()),
  author: AuthorSchema,
  at: z.string(),
  revisionBefore: z.int(),
  revision: z.int(),
  touched: z.array(z.string()).describe("Ids of the tracks and clips this operation changed."),
});

/** Consecutive-in-time operations of one transaction, oldest first. */
export const HistoryTransactionSchema = z.object({
  tx: TxIdSchema,
  label: z.string().nullable().describe("Label from `tx begin`; null for automatic grouping."),
  author: AuthorSchema.describe("Author of the transaction's first operation."),
  at: z.string().describe("ISO 8601 time of its first operation."),
  operations: z.array(HistoryOperationSchema),
});

/** Result of `history`. */
export const HistoryResultSchema = z.object({
  timeline: z.string(),
  revision: z.int().nullable().describe("Revision after the last journaled operation; null when the journal is empty."),
  since: TxIdSchema.nullable().describe("The `since` transaction; only operations journaled after its last one are listed."),
  transactions: z.array(HistoryTransactionSchema).describe("Oldest first."),
});

/** See {@link HistoryResultSchema}. */
export type HistoryResult = z.output<typeof HistoryResultSchema>;
/** See {@link HistoryTransactionSchema}. */
export type HistoryTransaction = z.output<typeof HistoryTransactionSchema>;
/** See {@link HistoryOperationSchema}. */
export type HistoryOperation = z.output<typeof HistoryOperationSchema>;

/** A transaction as `tx.begin`, `tx.commit` and `tx.abort` report it. */
export const TransactionInfoSchema = z.object({
  tx: TxIdSchema,
  label: z.string(),
  author: AuthorSchema,
});

/** An explicit transaction still open (`tx begin` without commit or abort), as `status` lists it. */
export const OpenTransactionSchema = z.object({
  tx: TxIdSchema,
  label: z.string(),
  author: AuthorSchema,
  session: z
    .string()
    .nullable()
    .describe(
      "Terminal session of a `cli:<session>` author; null for other authors. A shell that closed with it open " +
        "can still end it: `FRAMESHELL_SESSION=<session> frameshell tx commit` (or `tx abort`).",
    ),
  operations: z.int().describe("Operations applied in it so far, every timeline."),
  timelines: z.array(z.string()).describe("Ids of the project's timelines it changed, e.g. `main`."),
  openedAt: z.string().nullable().describe("ISO 8601 time of `tx begin`; null when not recorded (opened by an older daemon)."),
  ageMs: z.number().nullable().describe("Milliseconds since `openedAt`; null when unknown."),
});

/** See {@link OpenTransactionSchema}. */
export type OpenTransaction = z.output<typeof OpenTransactionSchema>;

/** An operation that blocks a revert: it came later and changed what the revert would restore. */
export const RevertConflictSchema = z.object({
  id: OpIdSchema,
  op: z.string(),
  author: AuthorSchema,
  tx: TxIdSchema,
  ids: z.array(z.string()).describe("Track and clip ids both operations changed."),
});

/** See {@link RevertConflictSchema}. */
export type RevertConflict = z.output<typeof RevertConflictSchema>;
