import type { ClipDiff, HistoryTransaction, RevertConflict } from "@frameshell/protocol";
import { useCallback, useRef, useState } from "react";
import {
  authorOf,
  diffCounts,
  historySelection,
  newestFirst,
  operationTitle,
  transactionTitle,
} from "../history/model.js";
import { loadHistoryDiff, useHistoryDiff, useTimelineHistory } from "../history/useHistory.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";

/** Timeline whose journal the panel lists: the one the timeline panel shows and selections name. */
const TIMELINE = SELECTION_TIMELINE;

/** Feedback under a row after a revert or a failed diff. */
interface Notice {
  /** Row it belongs to: the transaction or operation acted on. */
  target: string;
  tone: "info" | "error";
  text: string;
  /** Later operations to revert first; empty unless the daemon refused with a conflict. */
  conflicts: RevertConflict[];
}

/**
 * History panel (SPEC §6.2, §10): the main timeline's transactions, newest
 * first, by author (you, a terminal session, a direct file edit, a plugin),
 * with label, operation count and time. Live: re-read on each revision of
 * the shared timeline feed. Selecting a transaction or one operation selects
 * it in the shared selection store; the timeline highlights what it did.
 * Revert undoes it as a new `ui` operation; a conflict lists the later
 * operations to revert first.
 */
export function HistoryPanel() {
  const { history, error } = useTimelineHistory(TIMELINE);
  const { view } = useTimelineView(TIMELINE);
  const { history: selected } = useSelection();
  const { diff } = useHistoryDiff(TIMELINE, selected, view?.revision ?? null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latestView = useRef(view);
  latestView.current = view;

  /**
   * Select `target`: its clips still on the timeline, revealed; its changes
   * highlighted. `newest`: the operation just applied, whose clips are on the
   * timeline even when its `timeline.changed` has not reached the view yet.
   */
  const select = useCallback(async (target: string, newest = false) => {
    const current = latestView.current;
    try {
      const { clips } = await loadHistoryDiff(TIMELINE, target, current?.revision ?? null);
      const present = new Set((latestView.current ?? current)?.tracks.flatMap((track) => track.clips.map((clip) => clip.id)) ?? []);
      if (newest) for (const mark of clips) if (mark.after) present.add(mark.clip);
      const picked = historySelection(clips, present);
      selection.selectHistory(target, picked.clips, picked.reveal);
    } catch (failure) {
      selection.selectHistory(target, [], null);
      setNotice({ target, tone: "error", text: (failure as Error).message, conflicts: [] });
    }
  }, []);

  const revert = async (target: string) => {
    setBusy(target);
    setNotice(null);
    try {
      const outcome = await window.frameshell.history.revert(TIMELINE, target);
      if (outcome.status === "conflict") {
        setNotice({
          target,
          tone: "error",
          text: "Later changes touch the same clips. Revert them first, newest first, or edit forward.",
          conflicts: [...outcome.conflicts].reverse(),
        });
        return;
      }
      setNotice({ target, tone: "info", text: `Reverted as ${outcome.result.operation.id}.`, conflicts: [] });
      // Show what the revert itself changed.
      void select(outcome.result.operation.tx, true);
    } catch (failure) {
      setNotice({ target, tone: "error", text: (failure as Error).message, conflicts: [] });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (key: string) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (error && !history) return <p className="empty timeline-error">{error}</p>;
  if (!history) return null;
  if (history.transactions.length === 0) {
    return <p className="empty">No changes yet. Edits you make, the agent&apos;s commands and direct file edits are listed here.</p>;
  }

  const rows = newestFirst(history.transactions);
  const selectedOpTx = selected?.startsWith("op_")
    ? history.transactions.find((tx) => tx.operations.some((op) => op.id === selected))?.tx
    : undefined;
  return (
    <ul
      className="history"
      aria-label={`History of timeline ${TIMELINE}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") selection.clear();
      }}
    >
      {rows.map(({ key, tx }) => {
        const open = expanded.has(key) || tx.tx === selectedOpTx;
        const active = selected === tx.tx;
        return (
          <li key={key} className="history-item" data-tx={tx.tx} data-selected={active || undefined}>
            <TransactionRow
              tx={tx}
              active={active}
              open={open}
              busy={busy}
              diff={active ? (diff?.clips ?? null) : null}
              onToggle={() => toggle(key)}
              onSelect={() => void select(tx.tx)}
              onRevert={() => void revert(tx.tx)}
            />
            {notice && notice.target === tx.tx && <NoticeBox notice={notice} onShow={(id) => void select(id)} />}
            {open && (
              <ul className="history-ops" aria-label={`Operations of ${tx.tx}`}>
                {tx.operations.map((op) => (
                  <li key={op.id} data-op={op.id} data-selected={selected === op.id || undefined}>
                    <div className={`history-op${selected === op.id ? " is-active" : ""}`}>
                      <button className="history-op-main" onClick={() => void select(op.id)} title={`${op.id}, revision ${op.revision}`}>
                        <span className="history-op-title">{operationTitle(op)}</span>
                        <span className="history-op-touched">{op.touched.join(" ")}</span>
                      </button>
                      <button
                        className="history-revert"
                        disabled={busy !== null}
                        onClick={() => void revert(op.id)}
                        aria-label={`Revert operation ${op.id}`}
                      >
                        Revert
                      </button>
                    </div>
                    {selected === op.id && diff && <DiffSummary diff={diff.clips} />}
                    {notice && notice.target === op.id && <NoticeBox notice={notice} onShow={(id) => void select(id)} />}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TransactionRow({
  tx,
  active,
  open,
  busy,
  diff,
  onToggle,
  onSelect,
  onRevert,
}: {
  tx: HistoryTransaction;
  active: boolean;
  open: boolean;
  busy: string | null;
  diff: readonly ClipDiff[] | null;
  onToggle: () => void;
  onSelect: () => void;
  onRevert: () => void;
}) {
  const author = authorOf(tx.author);
  const count = tx.operations.length;
  return (
    <>
      <div className={`history-row${active ? " is-active" : ""}`}>
        <button
          className="history-expand"
          aria-expanded={open}
          aria-label={open ? "Hide operations" : "Show operations"}
          title={open ? "Hide operations" : "Show operations"}
          onClick={onToggle}
        >
          <span className={`tree-glyph ${open ? "dir-open" : "dir"}`} />
        </button>
        <button className="history-main" onClick={onSelect} title={tx.tx}>
          <span className="history-title">{transactionTitle(tx)}</span>
          <span className="history-meta">
            <span className={`history-author author-${author.kind}`} title={tx.author}>
              {author.name}
              {author.detail && <span className="history-author-detail">{author.detail}</span>}
            </span>
            <span className="history-count">{`${count} ${count === 1 ? "op" : "ops"}`}</span>
          </span>
        </button>
        <div className="history-side">
          <time className="history-time" dateTime={tx.at} title={new Date(tx.at).toLocaleString()}>
            {clock(tx.at)}
          </time>
          <button className="history-revert" disabled={busy !== null} onClick={onRevert} aria-label={`Revert ${tx.tx}`}>
            {busy === tx.tx ? "Reverting" : "Revert"}
          </button>
        </div>
      </div>
      {diff && <DiffSummary diff={diff} />}
    </>
  );
}

/** What the selected entry changed, in the colors and glyphs the timeline marks it with. */
function DiffSummary({ diff }: { diff: readonly ClipDiff[] }) {
  if (diff.length === 0) return <p className="history-diff">No clip changes left to show.</p>;
  const counts = diffCounts(diff);
  const parts = (
    [
      ["added", "+", "added"],
      ["removed", "−", "removed"],
      ["moved", "↔", "moved"],
      ["changed", "~", "changed"],
    ] as const
  ).filter(([kind]) => counts[kind] > 0);
  return (
    <p className="history-diff" aria-label="Changes shown on the timeline">
      {parts.map(([kind, glyph, word]) => (
        <span key={kind} className={`diff-count diff-${kind}`}>
          <span className="diff-glyph" aria-hidden="true">
            {glyph}
          </span>
          {`${counts[kind]} ${word}`}
        </span>
      ))}
    </p>
  );
}

function NoticeBox({ notice, onShow }: { notice: Notice; onShow: (id: string) => void }) {
  return (
    <div className={`history-notice${notice.tone === "error" ? " is-error" : ""}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      {notice.conflicts.length > 0 && (
        <ul className="history-conflicts" aria-label="Conflicting operations">
          {notice.conflicts.map((conflict) => (
            <li key={conflict.id} data-conflict={conflict.id}>
              <button className="link" onClick={() => onShow(conflict.id)} title={`Show ${conflict.id} on the timeline`}>
                {`${operationTitle({ op: conflict.op, args: {} })} (${authorOf(conflict.author).name})`}
              </button>
              <span className="history-conflict-ids">{conflict.ids.join(" ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Wall-clock time of an ISO instant, with the date when it is not today. */
function clock(at: string): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
