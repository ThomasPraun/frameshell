import type { ReactNode } from "react";

/** Slim header shared by every panel; the collapse control sits on the edge the panel folds toward. */
export function PanelHeader({
  children,
  onCollapse,
  collapseLabel,
  collapseSide,
}: {
  children: ReactNode;
  onCollapse?: () => void;
  collapseLabel?: string;
  collapseSide?: "left" | "right" | "down" | "up";
}) {
  return (
    <div className="panel-header">
      <div className="panel-header-content">{children}</div>
      {onCollapse && (
        <button className="icon-button" aria-label={collapseLabel} title={collapseLabel} onClick={onCollapse}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={CHEVRONS[collapseSide ?? "left"]} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      )}
    </div>
  );
}

const CHEVRONS = {
  left: "M10 3L5 8l5 5",
  right: "M6 3l5 5-5 5",
  down: "M3 6l5 5 5-5",
  up: "M3 10l5-5 5 5",
};
