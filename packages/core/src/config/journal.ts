import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  AuthorSchema,
  type ConfigDoc,
  type ConfigJournalEntry,
  ConfigJournalEntrySchema,
  type ConfigOperation,
  OpIdSchema,
} from "@frameshell/protocol";
import { FormatEntrySchema } from "@frameshell/schema";
import { z } from "zod";
import { appendJsonLine, readJsonLines } from "../fs-util.js";
import type { TxRef } from "../timeline/service.js";
import { type ConfigRules, type ConfigState, configHash, diffConfig } from "./patch.js";
import { FORMAT_RULES, formatState } from "./project-doc.js";
import { planConfigRevert } from "./revert.js";

/**
 * Journal of project-config changes (ADR 0036): one {@link ConfigJournalEntry} per line, every config document,
 * separate from the timeline journals. Timeline ids hold no `.`, so it never collides with one in the same folder.
 */
export const CONFIG_JOURNAL = ".frameshell/history/project.config.jsonl";

/** A line written before ADR 0036: a format edit with the whole list before and after, no transaction. */
const LegacyFormatLineSchema = z.object({
  id: OpIdSchema,
  op: z.string(),
  args: z.record(z.string(), z.unknown()),
  author: AuthorSchema,
  at: z.string(),
  before: z.array(FormatEntrySchema).nullable(),
  after: z.array(FormatEntrySchema).nullable(),
  undo: z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) }).optional(),
});

/**
 * Lines oldest first; empty without a journal. Lines written before ADR 0036 are read as `format:<id>` patches,
 * each its own transaction `tx_<hex of its op id>` (never rewritten on disk). Lines that do not parse are skipped.
 */
export async function readConfigJournal(root: string): Promise<ConfigJournalEntry[]> {
  const entries: ConfigJournalEntry[] = [];
  for (const value of await readJsonLines(join(root, ...CONFIG_JOURNAL.split("/")))) {
    const parsed = ConfigJournalEntrySchema.safeParse(value);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }
    const legacy = LegacyFormatLineSchema.safeParse(value);
    if (!legacy.success) continue;
    const { before, after, ...line } = legacy.data;
    const [from, to] = [formatState(before), formatState(after)];
    entries.push({
      ...line,
      tx: `tx_${line.id.slice("op_".length)}`,
      txLabel: null,
      doc: "project",
      patch: diffConfig(from, to, FORMAT_RULES),
      hashBefore: configHash(from),
      hash: configHash(to),
    });
  }
  return entries;
}

/** A config journal line as `revert`, `tx.abort` and `history` report it. */
export function configOperation(entry: ConfigJournalEntry): ConfigOperation {
  return {
    id: entry.id,
    op: entry.op,
    args: entry.args,
    author: entry.author,
    tx: entry.tx,
    at: entry.at,
    doc: entry.doc,
    touched: entry.patch.map((change) => change.key),
  };
}

/** How the journal reads and writes one config document of a project. */
export interface ConfigDocument {
  /** How its keys compare and are written; state from `read` and from `rules.apply` must agree for equal files. */
  rules: ConfigRules;
  /** Keyed state of the document in the project rooted at `root`. */
  read(root: string): Promise<ConfigState>;
  /** Write keyed state `state`, keeping everything else in the file. Throws when the result would not validate. */
  write(root: string, state: ConfigState): Promise<void>;
  /** Keys of `state` that break the document's rules in the project now (a proposal replayed on the person's edit); empty when none. */
  check?(root: string, state: ConfigState): Promise<string[]>;
}

/** What a config operation records besides its patch. */
export interface ConfigRecord {
  op: string;
  args: Record<string, unknown>;
  author: string;
  tx: TxRef;
  undo?: ConfigJournalEntry["undo"] | undefined;
  /** Op id to journal it under: the proposed operation's, once accepted (ADR 0019). Default: a new one. */
  id?: string | undefined;
  /** The proposal it was accepted from. */
  proposal?: string | undefined;
}

/** One change of a config document, made on the keyed state it applies to; see {@link ConfigChanger}. */
export interface ConfigEdit {
  op: string;
  args: Record<string, unknown>;
  undo?: ConfigJournalEntry["undo"] | undefined;
  /** The document's keyed state after the change. */
  after: ConfigState;
}

/** Where a config change went: journaled and written (`proposal` null), or held by review mode's open proposal. */
export interface ConfigChanged {
  operation: ConfigOperation;
  /** The document's keyed state after it: the file's, or the proposal's version. */
  state: ConfigState;
  /** Id of the proposal holding it; null when it was applied. */
  proposal: string | null;
}

/**
 * Make one change of config document `doc` of project `root` by `who` (ADR 0036): `make` gets the state it applies
 * to (`base`: the open proposal's version in review mode, else the file's) and the file's (`current`). Applied at
 * once, or held by review mode (ADR 0019); see `TimelineService.changeConfig`. Callers hold `ConfigJournal.serial(root)`.
 */
export type ConfigChanger = (
  root: string,
  doc: ConfigDoc,
  who: { author: string; tx: TxRef },
  make: (base: ConfigState, current: ConfigState) => Promise<ConfigEdit>,
) => Promise<ConfigChanged>;

/** A planned revert of one document: its state now and the state to write. */
export interface ConfigRevertPlan {
  doc: ConfigDoc;
  current: ConfigState;
  restored: ConfigState;
}

/** Options for {@link ConfigJournal}. */
export interface ConfigJournalOptions {
  docs: Record<ConfigDoc, ConfigDocument>;
  /** Clock for journal times. Default `new Date()`. */
  now?: () => Date;
}

/**
 * Writes project-config changes through {@link CONFIG_JOURNAL} (ADR 0036): every change of a registered document
 * is a keyed patch journaled before the file is written, in the caller's transaction, so `history`, `revert`
 * and `tx.abort` cover it. Changes and reverts of one project run one at a time ({@link ConfigJournal.serial}).
 */
export class ConfigJournal {
  readonly #docs: Record<ConfigDoc, ConfigDocument>;
  readonly #now: () => Date;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: ConfigJournalOptions) {
    this.#docs = options.docs;
    this.#now = options.now ?? (() => new Date());
  }

  /** Run `work` after every earlier config change of project `root`. The methods below expect to run inside it. */
  serial<T>(root: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(root) ?? Promise.resolve()).catch(() => {}).then(work);
    this.#queues.set(root, run);
    void run.catch(() => {}).then(() => {
      if (this.#queues.get(root) === run) this.#queues.delete(root);
    });
    return run;
  }

  /** Keyed state of `doc` in project `root`. */
  read(root: string, doc: ConfigDoc): Promise<ConfigState> {
    return this.#docs[doc].read(root);
  }

  /** Keys of `state` that would break `doc`'s rules in project `root`; empty when it can be written. */
  check(root: string, doc: ConfigDoc, state: ConfigState): Promise<string[]> {
    return this.#docs[doc].check?.(root, state) ?? Promise.resolve([]);
  }

  /** How `doc`'s keys compare and are written. */
  rules(doc: ConfigDoc): ConfigRules {
    return this.#docs[doc].rules;
  }

  /**
   * Journal the change of `doc` from `before` to `after`, then write it (`write` instead of the document's own
   * writer, for a caller that writes the whole file). Journal first: no change reaches the file without its line.
   */
  async commit(
    root: string,
    doc: ConfigDoc,
    record: ConfigRecord,
    before: ConfigState,
    after: ConfigState,
    write?: () => Promise<void>,
  ): Promise<ConfigJournalEntry> {
    const { tx, undo, id, proposal, ...rest } = record;
    const entry: ConfigJournalEntry = {
      id: id ?? `op_${randomBytes(4).toString("hex")}`,
      ...rest,
      tx: tx.id,
      txLabel: tx.label,
      at: this.#now().toISOString(),
      doc,
      patch: diffConfig(before, after, this.#docs[doc].rules),
      hashBefore: configHash(before),
      hash: configHash(after),
      ...(undo ? { undo } : {}),
      ...(proposal ? { proposal } : {}),
    };
    await appendJsonLine(join(root, ...CONFIG_JOURNAL.split("/")), entry);
    await (write ? write() : this.#docs[doc].write(root, after));
    return entry;
  }

  /** Whether a line of the config journal of `root` has op id or tx id `target`. */
  async has(root: string, target: string): Promise<boolean> {
    return (await readConfigJournal(root)).some((entry) => entry.id === target || entry.tx === target);
  }

  /** What reverting `target` writes, per document holding it (none: empty). Throws RevertConflict like `planConfigRevert`. */
  async planRevert(root: string, target: string): Promise<ConfigRevertPlan[]> {
    const entries = await readConfigJournal(root);
    const plans: ConfigRevertPlan[] = [];
    for (const doc of Object.keys(this.#docs) as ConfigDoc[]) {
      const lines = entries.filter((entry) => entry.doc === doc);
      if (!lines.some((entry) => entry.id === target || entry.tx === target)) continue;
      const current = await this.#docs[doc].read(root);
      plans.push({ doc, current, restored: planConfigRevert(current, lines, target, doc, this.#docs[doc].rules) });
    }
    return plans;
  }
}
