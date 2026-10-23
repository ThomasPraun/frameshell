import { useState } from "react";
import { authorOf } from "../history/model.js";
import { t } from "../i18n.js";
import { type ReviewSide, barOf, whoOf } from "../review/model.js";
import { decide, dismissStaleNotice, showSide, useReview } from "../review/store.js";

/**
 * Bar above the preview and timeline while review mode (ADR 0019) holds a proposal: who proposes what, a
 * Before / After toggle, Accept and Reject; or, once the person's own edit made it stale, why it is gone. Drawn in
 * the project window and in each detached panel's window; the side and the proposal are shared (one store), so
 * every copy says and does the same. Accepting or rejecting in one window settles it for all.
 */
export function ProposalBar() {
  const bar = barOf(useReview());
  const [failure, setFailure] = useState<string | null>(null);
  if (!bar) return null;

  if (bar.kind === "stale") {
    const { notice } = bar;
    return (
      <div className="proposal-bar is-stale" role="alert" aria-label={t.review.barLabel} data-state="stale" data-tx={notice.tx}>
        <span className="proposal-title">{notice.label ?? t.review.untitled}</span>
        <span className="proposal-status">{t.review.stale}</span>
        {notice.conflicts.length > 0 && <span className="proposal-ids">{t.review.staleIds(notice.conflicts.join(" "))}</span>}
        <span className="proposal-note">{t.review.staleAdvice}</span>
        <button className="button" onClick={dismissStaleNotice}>
          {t.review.dismiss}
        </button>
      </div>
    );
  }

  const { proposal, side } = bar;
  const author = authorOf(proposal.author);
  const run = (decision: "accept" | "reject") => async () => setFailure(await decide(proposal.tx, decision));
  return (
    <div className="proposal-bar" role="region" aria-label={t.review.barLabel} data-state={bar.kind} data-side={side} data-tx={proposal.tx}>
      <span className="proposal-title">{proposal.label ?? t.review.untitled}</span>
      <span className="proposal-who" title={author.detail ? `${author.name} ${author.detail}` : proposal.author}>
        {bar.kind === "building" ? t.review.building(whoOf(proposal.author)) : t.review.ready(whoOf(proposal.author))}
      </span>
      <span className="proposal-count">{t.review.operations(proposal.operations)}</span>
      <SideToggle side={side} />
      {failure && (
        <span className="proposal-failure" role="alert">
          {failure}
        </span>
      )}
      <span className="proposal-actions">
        <button className="button" onClick={run("reject")}>
          {t.review.reject}
        </button>
        <button className="button primary" disabled={bar.kind !== "ready"} onClick={run("accept")}>
          {t.review.accept}
        </button>
      </span>
    </div>
  );
}

function SideToggle({ side }: { side: ReviewSide }) {
  return (
    <span className="proposal-side" role="group" aria-label={t.review.sideLabel}>
      {(["before", "after"] as const).map((value) => (
        <button key={value} className={side === value ? "is-active" : undefined} aria-pressed={side === value} onClick={() => showSide(value)}>
          {value === "before" ? t.review.before : t.review.after}
        </button>
      ))}
    </span>
  );
}
