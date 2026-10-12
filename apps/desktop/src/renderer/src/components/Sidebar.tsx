import type { SidebarView } from "../../../shared/layout.js";
import { DetachButton, DockedElsewhere } from "./DetachControls.js";
import { Explorer } from "./Explorer.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { PanelHeader } from "./PanelHeader.js";

/** The sidebar's views, in tab order, with their names. */
export const SIDEBAR_VIEWS: readonly { id: SidebarView; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "history", label: "History" },
  { id: "plugins", label: "Plugins" },
];

/** Name of a sidebar view, as its tab shows it. */
export function sidebarLabel(view: SidebarView): string {
  return SIDEBAR_VIEWS.find(({ id }) => id === view)?.label ?? view;
}

/**
 * Left column: explorer, history and plugins as switchable views. Each view
 * can move to its own window (ADR 0012); its tab then shows where it went.
 */
export function Sidebar({
  view,
  onView,
  onCollapse,
  onOpenFile,
  activeFile,
  detached,
  onDetach,
}: {
  view: SidebarView;
  onView: (view: SidebarView) => void;
  onCollapse: () => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  /** Views shown in their own window. */
  detached: ReadonlySet<SidebarView>;
  /** Move a view to its own window (`true`) or dock it back. */
  onDetach: (view: SidebarView, detached: boolean) => void;
}) {
  const label = sidebarLabel(view).toLowerCase();
  return (
    <>
      <PanelHeader
        onCollapse={onCollapse}
        collapseLabel="Hide sidebar"
        collapseSide="left"
        actions={
          <DetachButton name={label} detached={false} disabled={detached.has(view)} onClick={() => onDetach(view, true)} testId="sidebar-detach" />
        }
      >
        <div className="view-switch" role="tablist" aria-label="Sidebar views">
          {SIDEBAR_VIEWS.map(({ id, label: name }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              className={`view-tab${view === id ? " is-active" : ""}${detached.has(id) ? " is-detached" : ""}`}
              title={detached.has(id) ? `${name}, in its own window` : undefined}
              onClick={() => onView(id)}
            >
              {name}
            </button>
          ))}
        </div>
      </PanelHeader>
      <div className="panel-body">
        {detached.has(view) ? (
          <DockedElsewhere title={sidebarLabel(view)} onBringBack={() => onDetach(view, false)} />
        ) : (
          <SidebarViewBody view={view} onOpenFile={onOpenFile} activeFile={activeFile} />
        )}
      </div>
    </>
  );
}

/** A sidebar view in its own window: its name, a way back, and the view. */
export function SidebarWindow({
  view,
  onDock,
  onOpenFile,
  activeFile,
}: {
  view: SidebarView;
  onDock: () => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
}) {
  const label = sidebarLabel(view);
  return (
    <div className="panel sidebar-window">
      <PanelHeader actions={<DetachButton name={label.toLowerCase()} detached onClick={onDock} testId="sidebar-detach" />}>
        <span className="panel-title">{label}</span>
      </PanelHeader>
      <div className="panel-body">
        <SidebarViewBody view={view} onOpenFile={onOpenFile} activeFile={activeFile} />
      </div>
    </div>
  );
}

function SidebarViewBody({ view, onOpenFile, activeFile }: { view: SidebarView; onOpenFile: (path: string) => void; activeFile: string | null }) {
  if (view === "explorer") return <Explorer onOpenFile={onOpenFile} activeFile={activeFile} />;
  if (view === "history") return <HistoryPanel />;
  return (
    <p className="empty">
      No plugins yet. Adapters such as HyperFrames and providers such as whisper.cpp will show up here with their trust
      state.
    </p>
  );
}
