// History panel model (SPEC §6.2): pure, DOM-free, so rows and selections are unit tested.
import type { ClipDiff, HistoryTransaction } from "@frameshell/protocol";
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
  if (author === "ui") return { kind: "ui", name: "You", detail: null };
  if (author === "file") return { kind: "file", name: "File", detail: null };
  if (author.startsWith("plugin:")) return { kind: "plugin", name: "Plugin", detail: author.slice("plugin:".length) };
  const agent = /^agent:([^:]+)(?::(.+))?$/.exec(author);
  if (agent) return { kind: "agent", name: `agent: ${agent[1]}`, detail: agent[2] ?? null };
  const session = author.startsWith("cli:") ? author.slice("cli:".length) : null;
  return { kind: "cli", name: "Terminal", detail: session };
}

/** Verbs for operation names; others show as named. */
const VERBS: Record<string, string> = {
  "clip.add": "Add clip",
  "clip.move": "Move",
  "clip.trim": "Trim",
  "clip.split": "Split",
  "clip.remove": "Delete",
  "clip.set": "Change clip",
  cut: "Ripple delete",
  "track.add": "Add track",
  "track.remove": "Remove track",
  "timeline.patch": "Direct edit",
};

/** One operation in words: its verb, `Revert <target>` for reverts. */
export function operationTitle(op: { op: string; args: Record<string, unknown> }): string {
  const target = op.args["target"];
  if (op.op === "revert") return typeof target === "string" ? `Revert ${target}` : "Revert";
  return VERBS[op.op] ?? op.op;
}

/**
 * Row title: the `tx begin` label, else what its operations did, in order of
 * first use with repeat counts ("Ripple delete ×2, trim").
 */
export function transactionTitle(tx: HistoryTransaction): string {
  if (tx.label) return tx.label;
  const counts = new Map<string, number>();
  for (const op of tx.operations) {
    const title = operationTitle(op);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const parts = [...counts].map(([title, count], index) => {
    // Later verbs read as a list: lowercase unless an id or op name.
    const word = index === 0 || /[._]/.test(title) ? title : title[0]!.toLowerCase() + title.slice(1);
    return count > 1 ? `${word} ×${count}` : word;
  });
  return parts.join(", ") || "Empty";
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

/** Counts of each change kind, for the row of the selected entry. */
export function diffCounts(diff: readonly ClipDiff[]): Record<ClipDiff["change"], number> {
  const counts = { added: 0, removed: 0, moved: 0, changed: 0 };
  for (const mark of diff) counts[mark.change]++;
  return counts;
}
