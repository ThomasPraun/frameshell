import type { SidebarView } from "../../../shared/layout.js";
import { Explorer } from "./Explorer.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { PanelHeader } from "./PanelHeader.js";

const VIEWS: { id: SidebarView; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "history", label: "History" },
  { id: "plugins", label: "Plugins" },
];

/** Left column: explorer, history and plugins as switchable views. */
export function Sidebar({
  view,
  onView,
  onCollapse,
  onOpenFile,
  activeFile,
}: {
  view: SidebarView;
  onView: (view: SidebarView) => void;
  onCollapse: () => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
}) {
  return (
    <>
      <PanelHeader onCollapse={onCollapse} collapseLabel="Hide sidebar" collapseSide="left">
        <div className="view-switch" role="tablist" aria-label="Sidebar views">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              className={`view-tab${view === id ? " is-active" : ""}`}
              onClick={() => onView(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </PanelHeader>
      <div className="panel-body">
        {view === "explorer" && <Explorer onOpenFile={onOpenFile} activeFile={activeFile} />}
        {view === "history" && <HistoryPanel />}
        {view === "plugins" && (
          <p className="empty">
            No plugins yet. Adapters such as HyperFrames and providers such as whisper.cpp will show up here with their
            trust state.
          </p>
        )}
      </div>
    </>
  );
}
