// History panel model (SPEC §6.2): pure, DOM-free, so rows and selections are unit tested.
import type { ClipDiff, HistoryTransaction } from "@frameshell/protocol";
import { t } from "../i18n.js";
import type { RevealRequest } from "../selection.js";

/** SPEC §6.2 author, split for display. */
export interface AuthorView {
  kind: "ui" | "cli" | "agent" | "file" | "plugin";
  /** Who, in words: `You`, `Terminal`, `agent: <label>` (an agent CLI), `File` (direct edit), `Plugin`. */
  name: string;
  /** Terminal session or plugin name; null when the author has none. */
  detail: string | null;
}

/**
 * Display form of an `author` string (`ui`, `cli`, `cli:<session>`,
 * `agent:<label>:<session>`, `file`, `plugin:<name>`).
 */
export function authorOf(author: string): AuthorView {
  if (author === "ui") return { kind: "ui", name: t.history.you, detail: null };
  if (author === "file") return { kind: "file", name: t.history.file, detail: null };
  if (author.startsWith("plugin:")) return { kind: "plugin", name: t.history.plugin, detail: author.slice("plugin:".length) };
  const agent = /^agent:([^:]+)(?::(.+))?$/.exec(author);
  if (agent) return { kind: "agent", name: t.history.agent(agent[1]!), detail: agent[2] ?? null };
  const session = author.startsWith("cli:") ? author.slice("cli:".length) : null;
  return { kind: "cli", name: t.history.terminal, detail: session };
}

/** Verbs for operation names; others show as named. */
const VERBS: Record<string, string> = {
  "clip.add": t.history.verbs.addClip,
  "clip.move": t.history.verbs.move,
  "clip.trim": t.history.verbs.trim,
  "clip.split": t.history.verbs.split,
  "clip.remove": t.history.verbs.delete,
  "clip.set": t.history.verbs.changeClip,
  "transition.set": t.history.verbs.setTransition,
  "transition.remove": t.history.verbs.removeTransition,
  "clip.key": t.history.verbs.keyframe,
  "track.duck": t.history.verbs.duckTrack,
  "music.shape": t.history.verbs.shapeMusic,
  cut: t.history.verbs.rippleDelete,
  "track.add": t.history.verbs.addTrack,
  "track.remove": t.history.verbs.removeTrack,
  "track.set": t.history.verbs.changeTrack,
  "multicam.create": t.history.verbs.multicamCreate,
  "multicam.gallery": t.history.verbs.multicamGallery,
  "multicam.offset": t.history.verbs.multicamOffset,
  "multicam.angle": t.history.verbs.multicamAngle,
  "multicam.mic": t.history.verbs.multicamMic,
  "multicam.reframe": t.history.verbs.multicamReframe,
  "multicam.paint": t.history.verbs.multicamPaint,
  "multicam.direct": t.history.verbs.multicamDirect,
  "shot.set": t.history.verbs.changeShot,
  "marker.add": t.history.verbs.addMarker,
  "marker.set": t.history.verbs.changeMarker,
  "marker.remove": t.history.verbs.removeMarker,
  "tempo.set": t.history.verbs.setTempo,
  "letterbox.set": t.history.verbs.setLetterbox,
  "timeline.patch": t.history.verbs.directEdit,
  "file.edit": t.history.verbs.directEdit,
  "format.add": t.history.verbs.addFormat,
  "format.remove": t.history.verbs.removeFormat,
};

/** Title of a history entry by id (`tx_…`, `op_…`), or undefined when the list does not hold it. */
export type TitleOf = (id: string) => string | undefined;

/**
 * One operation in words: its verb; for a revert, `Revert “<title>”` of what it undid, `Revert an earlier change`
 * when `titleOf` does not know it (its id is in the row's tooltip).
 */
export function operationTitle(op: { op: string; args: Record<string, unknown> }, titleOf: TitleOf = () => undefined): string {
  const target = op.args["target"];
  if (op.op !== "revert") return VERBS[op.op] ?? op.op;
  const title = typeof target === "string" ? titleOf(target) : undefined;
  return title === undefined ? t.history.revertEarlier : t.history.revertTarget(title);
}

/**
 * A journal label in the UI language. The app writes its labels in English (agents read the journal); known ones
 * and the composed kind (`Move clip`, `Ripple trim 3 clips`, `Add 2 layers`) are shown translated, any other label
 * (an agent's `tx begin`) as written.
 */
export function labelText(label: string): string {
  const fixed = own(t.history.labels, label);
  if (fixed !== undefined) return fixed;
  const one = /^(.+) ([a-z]+)$/.exec(label);
  const many = /^(.+) (\d+) ([a-z]+)s$/.exec(label);
  if (many) {
    const [, verb = "", count = "", noun = ""] = many;
    const verbText = own(t.history.editVerbs, verb);
    const nouns = own(t.history.editNouns, noun);
    if (verbText !== undefined && nouns !== undefined) return `${verbText} ${count} ${nouns[1]}`;
  }
  if (one) {
    const [, verb = "", noun = ""] = one;
    const verbText = own(t.history.editVerbs, verb);
    const nouns = own(t.history.editNouns, noun);
    if (verbText !== undefined && nouns !== undefined) return `${verbText} ${nouns[0]}`;
  }
  const angle = /^Cut to (.+)$/.exec(label);
  return angle ? t.history.cutToAngle(angle[1]!) : label;
}

/** `record[key]` when it is the record's own entry (never `toString` and the like). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Row title: the `tx begin` label, else what its operations did, in order of
 * first use with repeat counts ("Ripple delete ×2, trim").
 */
export function transactionTitle(tx: HistoryTransaction, titleOf: TitleOf = () => undefined): string {
  if (tx.label) return labelText(tx.label);
  const counts = new Map<string, number>();
  for (const op of tx.operations) {
    const title = operationTitle(op, titleOf);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const parts = [...counts].map(([title, count], index) => {
    // Later verbs read as a list: lowercase unless an id, an op name or a quoted title.
    const word = index === 0 || /[._“«]/.test(title) ? title : title[0]!.toLowerCase() + title.slice(1);
    return count > 1 ? `${word} ×${count}` : word;
  });
  return parts.join(", ") || t.history.empty;
}

/**
 * Ids of aborted transactions: one of their operations reverts the
 * transaction itself (`tx.abort`, or a refused desktop edit undoing what
 * applied before the refusal), so together they changed nothing. The whole
 * list is scanned because an interleaved transaction shows as several rows
 * and only its last one holds the revert.
 */
export function abortedTransactions(transactions: readonly HistoryTransaction[]): Set<string> {
  const aborted = new Set<string>();
  for (const tx of transactions) {
    if (tx.operations.some((op) => op.op === "revert" && op.args["target"] === tx.tx)) aborted.add(tx.tx);
  }
  return aborted;
}

/** Whether `tx` changed project config (ADR 0036): any of its operations names a config `doc`. */
export function changesConfig(tx: HistoryTransaction): boolean {
  return tx.operations.some((op) => op.doc !== undefined);
}

/** A history row: one run of a transaction, keyed uniquely (a transaction interleaved with others' operations shows as several runs). */
export interface HistoryRow {
  key: string;
  tx: HistoryTransaction;
}

/** `history` transactions (oldest first) as rows, newest first. */
export function newestFirst(transactions: readonly HistoryTransaction[]): HistoryRow[] {
  return transactions.map((tx, index) => ({ key: `${tx.tx}#${index}`, tx })).reverse();
}

/**
 * What selecting a history entry selects: the clips its diff left that the
 * timeline still has (`present`), and where to look: the first of them, else
 * the first clip it removed, where it was.
 */
export function historySelection(
  diff: readonly ClipDiff[],
  present: ReadonlySet<string>,
): { clips: string[]; reveal: RevealRequest | null } {
  const clips = diff.filter((mark) => mark.after && present.has(mark.clip)).map((mark) => mark.clip);
  const shown = diff.find((mark) => mark.clip === clips[0]);
  if (shown?.after) return { clips, reveal: { clip: shown.clip, place: shown.after } };
  const removed = diff.find((mark) => mark.before && !mark.after);
  return { clips, reveal: removed?.before ? { clip: removed.clip, place: removed.before } : null };
}

/**
 * Titles of every entry of `transactions`, by id: transactions and their operations. A revert's title names what it
 * undid by its title too, so `Revert “Move clip”`, not `Revert tx_…`.
 */
export function entryTitles(transactions: readonly HistoryTransaction[]): TitleOf {
  const titles = new Map<string, string>();
  const titleOf: TitleOf = (id) => titles.get(id);
  // Oldest first: a revert names an earlier entry, already titled.
  for (const tx of transactions) {
    for (const op of tx.operations) titles.set(op.id, operationTitle(op, titleOf));
    if (!titles.has(tx.tx)) titles.set(tx.tx, transactionTitle(tx, titleOf));
  }
  return titleOf;
}

/**
 * What an undo or redo of entry `target` brings back or takes away, in words: the title of the entry at the end of
 * its chain of reverts (a redo reverts the undo, which reverted the edit). Null when the journal does not hold it.
 */
export function undoneTitle(transactions: readonly HistoryTransaction[], target: string): string | null {
  const titleOf = entryTitles(transactions);
  let id = target;
  for (let hops = 0; hops < 64; hops++) {
    const tx = transactions.find((each) => each.tx === id);
    const only = tx?.operations.length === 1 ? tx.operations[0] : undefined;
    const next = only?.op === "revert" ? only.args["target"] : undefined;
    if (typeof next !== "string") break;
    id = next;
  }
  return titleOf(id) ?? null;
}

/** Counts of each change kind, for the row of the selected entry. */
export function diffCounts(diff: readonly ClipDiff[]): Record<ClipDiff["change"], number> {
  const counts = { added: 0, removed: 0, moved: 0, changed: 0 };
  for (const mark of diff) counts[mark.change]++;
  return counts;
}
