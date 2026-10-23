import type { SidebarView } from "../../../shared/layout.js";
import { t } from "../i18n.js";
import { AngleViewer } from "./AngleViewer.js";
import { DetachButton, DockedElsewhere } from "./DetachControls.js";
import { Explorer } from "./Explorer.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { PanelHeader } from "./PanelHeader.js";
import { ReviewSwitch } from "./ReviewSwitch.js";

/** The sidebar's views, in tab order, with their names. */
export const SIDEBAR_VIEWS: readonly { id: SidebarView; label: string }[] = [
  { id: "explorer", label: t.workspace.explorer },
  { id: "history", label: t.workspace.history },
  { id: "plugins", label: t.workspace.plugins },
  { id: "angles", label: t.workspace.angles },
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
  mediaUrl,
  detached,
  onDetach,
}: {
  view: SidebarView;
  onView: (view: SidebarView) => void;
  onCollapse: () => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  /** Base URL of the project's derived media, for the angle viewer. */
  mediaUrl: string;
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
        collapseLabel={t.workspace.hideSidebar}
        collapseSide="left"
        actions={
          <DetachButton name={label} detached={false} disabled={detached.has(view)} onClick={() => onDetach(view, true)} testId="sidebar-detach" />
        }
      >
        <div className="view-switch" role="tablist" aria-label={t.workspace.sidebarViews}>
          {SIDEBAR_VIEWS.map(({ id, label: name }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              className={`view-tab${view === id ? " is-active" : ""}${detached.has(id) ? " is-detached" : ""}`}
              title={detached.has(id) ? t.workspace.inOwnWindow(name) : undefined}
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
          <SidebarViewBody view={view} onOpenFile={onOpenFile} activeFile={activeFile} mediaUrl={mediaUrl} />
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
  mediaUrl,
}: {
  view: SidebarView;
  onDock: () => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  mediaUrl: string;
}) {
  const label = sidebarLabel(view);
  return (
    <div className="panel sidebar-window">
      <PanelHeader actions={<DetachButton name={label.toLowerCase()} detached onClick={onDock} testId="sidebar-detach" />}>
        <span className="panel-title">{label}</span>
      </PanelHeader>
      <div className="panel-body">
        <SidebarViewBody view={view} onOpenFile={onOpenFile} activeFile={activeFile} mediaUrl={mediaUrl} />
      </div>
    </div>
  );
}

function SidebarViewBody({
  view,
  onOpenFile,
  activeFile,
  mediaUrl,
}: {
  view: SidebarView;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  mediaUrl: string;
}) {
  if (view === "explorer") return <Explorer onOpenFile={onOpenFile} activeFile={activeFile} />;
  if (view === "history") {
    return (
      <>
        <ReviewSwitch />
        <HistoryPanel />
      </>
    );
  }
  if (view === "angles") return <AngleViewer mediaUrl={mediaUrl} />;
  return (
    <p className="empty">
      {t.workspace.noPlugins}
    </p>
  );
}
