import type { ClipDiff, HistoryTransaction, RevertConflict } from "@frameshell/protocol";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { openAskMenu } from "../ask/ask-agent.js";
import { abortedTransactions, authorOf, diffCounts, newestFirst, operationTitle, transactionTitle } from "../history/model.js";
import { t } from "../i18n.js";
import { selectHistoryEntry, useHistoryDiff, useTimelineHistory } from "../history/useHistory.js";
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
 * operations to revert first. An aborted transaction changed nothing: it
 * shows dimmed, marked "aborted", with no Revert.
 */
export function HistoryPanel() {
  const { history, error } = useTimelineHistory(TIMELINE);
  const { view } = useTimelineView(TIMELINE);
  const { history: selected, origin } = useSelection();
  const { diff } = useHistoryDiff(TIMELINE, selected, view?.revision ?? null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const list = useRef<HTMLUListElement>(null);

  // An entry the agent shows (`ui_show_tx_diff`) may be far down the list: bring its row into view.
  useEffect(() => {
    if (origin !== "agent" || !selected) return;
    const attribute = selected.startsWith("op_") ? "data-op" : "data-tx";
    list.current?.querySelector(`[${attribute}="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [origin, selected, history]);

  /** Select `target`: its clips still on the timeline, revealed; its changes highlighted. */
  const select = useCallback(async (target: string, revision?: number) => {
    try {
      await selectHistoryEntry(TIMELINE, target, "history", revision === undefined ? {} : { revision });
    } catch (failure) {
      selection.selectHistory(target, [], null);
      setNotice({ target, tone: "error", text: (failure as Error).message, conflicts: [] });
    }
  }, []);

  /**
   * Right-click on a transaction or operation: select it (its diff shows on the timeline), then Ask agent, Revert and,
   * for a transaction, show or hide its operations. Opens once the selection is in, so Ask agent names the entry.
   */
  const openMenu = async (event: MouseEvent, target: string, options: { aborted: boolean; toggle?: { open: boolean; run: () => void } }) => {
    event.preventDefault();
    await select(target);
    openAskMenu(event, [
      { label: t.history.revert, separated: true, disabled: options.aborted || busy !== null, run: () => void revert(target) },
      ...(options.toggle ? [{ label: options.toggle.open ? t.history.hideOps : t.history.showOps, run: options.toggle.run }] : []),
    ]);
  };

  const revert = async (target: string) => {
    setBusy(target);
    setNotice(null);
    try {
      const outcome = await window.frameshell.history.revert(TIMELINE, target);
      if (outcome.status === "conflict") {
        setNotice({
          target,
          tone: "error",
          text: t.history.conflict,
          conflicts: [...outcome.conflicts].reverse(),
        });
        return;
      }
      setNotice({ target, tone: "info", text: t.history.reverted(outcome.result.operation.id), conflicts: [] });
      // Show what the revert itself changed.
      void select(outcome.result.operation.tx, outcome.result.revision);
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
    return <p className="empty">{t.history.none}</p>;
  }

  const rows = newestFirst(history.transactions);
  const aborted = abortedTransactions(history.transactions);
  const selectedOpTx = selected?.startsWith("op_")
    ? history.transactions.find((tx) => tx.operations.some((op) => op.id === selected))?.tx
    : undefined;
  return (
    <ul
      ref={list}
      className="history"
      aria-label={t.history.listLabel(TIMELINE)}
      onKeyDown={(event) => {
        if (event.key === "Escape") selection.clear();
      }}
    >
      {rows.map(({ key, tx }) => {
        const open = expanded.has(key) || tx.tx === selectedOpTx;
        const active = selected === tx.tx;
        const isAborted = aborted.has(tx.tx);
        return (
          <li
            key={key}
            className="history-item"
            data-tx={tx.tx}
            data-selected={active || undefined}
            data-aborted={isAborted || undefined}
          >
            <TransactionRow
              tx={tx}
              active={active}
              aborted={isAborted}
              open={open}
              busy={busy}
              diff={active ? (diff?.clips ?? null) : null}
              onToggle={() => toggle(key)}
              onSelect={() => void select(tx.tx)}
              onRevert={() => void revert(tx.tx)}
              onMenu={(event) => void openMenu(event, tx.tx, { aborted: isAborted, toggle: { open, run: () => toggle(key) } })}
            />
            {notice && notice.target === tx.tx && <NoticeBox notice={notice} onShow={(id) => void select(id)} />}
            {open && (
              <ul className="history-ops" aria-label={t.history.opsLabel(tx.tx)}>
                {tx.operations.map((op) => (
                  <li key={op.id} data-op={op.id} data-selected={selected === op.id || undefined}>
                    <div
                      className={`history-op${selected === op.id ? " is-active" : ""}`}
                      onContextMenu={(event) => void openMenu(event, op.id, { aborted: isAborted })}
                    >
                      <button className="history-op-main" onClick={() => void select(op.id)} title={t.history.opTitle(op.id, op.revision)}>
                        <span className="history-op-title">{operationTitle(op)}</span>
                        <span className="history-op-touched">{op.touched.join(" ")}</span>
                      </button>
                      {!isAborted && (
                        <button
                          className="history-revert"
                          disabled={busy !== null}
                          onClick={() => void revert(op.id)}
                          aria-label={t.history.revertOp(op.id)}
                        >
                          {t.history.revert}
                        </button>
                      )}
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
  aborted,
  open,
  busy,
  diff,
  onToggle,
  onSelect,
  onRevert,
  onMenu,
}: {
  tx: HistoryTransaction;
  active: boolean;
  /** Changed nothing (see {@link abortedTransactions}): dimmed, marked, no Revert. */
  aborted: boolean;
  open: boolean;
  busy: string | null;
  diff: readonly ClipDiff[] | null;
  onToggle: () => void;
  onSelect: () => void;
  onRevert: () => void;
  onMenu: (event: MouseEvent) => void;
}) {
  const author = authorOf(tx.author);
  const count = tx.operations.length;
  return (
    <>
      <div className={`history-row${active ? " is-active" : ""}${aborted ? " is-aborted" : ""}`} onContextMenu={onMenu}>
        <button
          className="history-expand"
          aria-expanded={open}
          aria-label={open ? t.history.hideOps : t.history.showOps}
          title={open ? t.history.hideOps : t.history.showOps}
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
            <span className="history-count">{t.history.opCount(count)}</span>
            {aborted && (
              <span className="history-aborted" title={t.history.abortedTitle}>
                {t.history.aborted}
              </span>
            )}
          </span>
        </button>
        <div className="history-side">
          <time className="history-time" dateTime={tx.at} title={new Date(tx.at).toLocaleString()}>
            {clock(tx.at)}
          </time>
          {!aborted && (
            <button className="history-revert" disabled={busy !== null} onClick={onRevert} aria-label={t.history.revertTx(tx.tx)}>
              {busy === tx.tx ? t.history.reverting : t.history.revert}
            </button>
          )}
        </div>
      </div>
      {diff && <DiffSummary diff={diff} />}
    </>
  );
}

/** What the selected entry changed, in the colors and glyphs the timeline marks it with. */
function DiffSummary({ diff }: { diff: readonly ClipDiff[] }) {
  if (diff.length === 0) return <p className="history-diff">{t.history.noClipChanges}</p>;
  const counts = diffCounts(diff);
  const parts = (
    [
      ["added", "+", t.history.added],
      ["removed", "−", t.history.removed],
      ["moved", "↔", t.history.moved],
      ["changed", "~", t.history.changed],
    ] as const
  ).filter(([kind]) => counts[kind] > 0);
  return (
    <p className="history-diff" aria-label={t.history.changesLabel}>
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
        <ul className="history-conflicts" aria-label={t.history.conflictsLabel}>
          {notice.conflicts.map((conflict) => (
            <li key={conflict.id} data-conflict={conflict.id}>
              <button className="link" onClick={() => onShow(conflict.id)} title={t.history.showOnTimeline(conflict.id)}>
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
