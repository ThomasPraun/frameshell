import { type MouseEvent, type WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SidebarView } from "../../../shared/layout.js";
import { t } from "../i18n.js";
import { panelShortcut } from "../shortcuts.js";
import { type Overflow, tabOverflow } from "../tab-overflow.js";
import { windowOf } from "../windows.js";
import { AngleViewer } from "./AngleViewer.js";
import { contextMenu } from "./ContextMenu.js";
import { DetachButton, DockedElsewhere } from "./DetachControls.js";
import { Explorer } from "./Explorer.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { PanelHeader } from "./PanelHeader.js";
import { PeoplePanel } from "./PeoplePanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { ReviewSwitch } from "./ReviewSwitch.js";
import { ShootPanel } from "./ShootPanel.js";
import { TeleprompterPanel } from "./TeleprompterPanel.js";

/** The sidebar's views, in tab order, with their names. */
export const SIDEBAR_VIEWS: readonly { id: SidebarView; label: string }[] = [
  { id: "explorer", label: t.workspace.explorer },
  { id: "history", label: t.workspace.history },
  { id: "plugins", label: t.workspace.plugins },
  { id: "angles", label: t.workspace.angles },
  { id: "people", label: t.workspace.people },
  { id: "shoot", label: t.workspace.shoot },
  { id: "teleprompter", label: t.workspace.teleprompter },
];

/** The views an image project (ADR 0017) offers: no one speaks or is recorded in a picture, so no People, Shoot or Teleprompter view. */
export function sidebarViews(image: boolean): readonly { id: SidebarView; label: string }[] {
  return image ? SIDEBAR_VIEWS.filter(({ id }) => id !== "people" && id !== "shoot" && id !== "teleprompter") : SIDEBAR_VIEWS;
}

/** Name of a sidebar view, as its tab shows it. */
export function sidebarLabel(view: SidebarView): string {
  return SIDEBAR_VIEWS.find(({ id }) => id === view)?.label ?? view;
}

/**
 * Left column: explorer, history, plugins, angles, people, shoot and teleprompter as switchable views. Each view
 * can move to its own window (ADR 0012); its tab then shows where it went.
 */
export function Sidebar({
  image,
  view: asked,
  onView,
  onCollapse,
  onOpenFile,
  activeFile,
  mediaUrl,
  detached,
  onDetach,
}: {
  /** An image project: the views that need sound or faces are left out. */
  image: boolean;
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
  const views = sidebarViews(image);
  const view = views.some(({ id }) => id === asked) ? asked : "explorer";
  const label = sidebarLabel(view).toLowerCase();
  return (
    <>
      <PanelHeader
        onCollapse={onCollapse}
        collapseLabel={t.workspace.hideSidebar}
        collapseKey={panelShortcut("sidebar")}
        collapseSide="left"
        actions={
          <DetachButton name={label} detached={false} disabled={detached.has(view)} onClick={() => onDetach(view, true)} testId="sidebar-detach" />
        }
      >
        <ViewTabs views={views} view={view} detached={detached} onView={onView} />
      </PanelHeader>
      <div className="panel-body">
        {detached.has(view) ? (
          <DockedElsewhere title={sidebarLabel(view)} onBringBack={() => onDetach(view, false)} />
        ) : (
          <SidebarViewBody view={view} onOpenFile={onOpenFile} activeFile={activeFile} mediaUrl={mediaUrl} onShowPeople={() => onView("people")} onShowPlugins={() => onView("plugins")} />
        )}
      </div>
    </>
  );
}

const NO_OVERFLOW: Overflow = { before: false, after: false, hidden: [] };

/**
 * The sidebar's view tabs (#736). A strip narrower than its tabs scrolls (wheel or drag), fades at the edge where
 * tabs are cut off, and ends in a More button listing every view out of sight; the active tab scrolls into view.
 */
function ViewTabs({
  views,
  view,
  detached,
  onView,
}: {
  views: readonly { id: SidebarView; label: string }[];
  view: SidebarView;
  detached: ReadonlySet<SidebarView>;
  onView: (view: SidebarView) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW);
  const measure = useCallback(() => {
    const element = strip.current;
    if (!element) return;
    const spans = [...element.children].map((child) => {
      const tab = child as HTMLElement;
      return { start: tab.offsetLeft - element.offsetLeft, end: tab.offsetLeft - element.offsetLeft + tab.offsetWidth };
    });
    const next = tabOverflow(spans, element.scrollLeft, element.clientWidth);
    setOverflow((current) =>
      current.before === next.before && current.after === next.after && current.hidden.join() === next.hidden.join() ? current : next,
    );
  }, []);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    measure();
    const observer = new (element.ownerDocument.defaultView ?? window).ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, views]);
  // The active tab is never left out of sight, also when another view or a menu switched to it.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view]);
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0 || !strip.current) return;
    strip.current.scrollLeft += event.deltaY;
  };
  const more = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    contextMenu.open(
      box.left,
      box.bottom,
      overflow.hidden.flatMap((index) => {
        const entry = views[index];
        return entry ? [{ label: entry.label, run: () => onView(entry.id) }] : [];
      }),
      windowOf(event.currentTarget),
    );
  };
  return (
    <div className={`view-switch-wrap${overflow.before ? " has-before" : ""}${overflow.after ? " has-after" : ""}`}>
      <div className="view-switch" role="tablist" aria-label={t.workspace.sidebarViews} ref={strip} onScroll={measure} onWheel={onWheel}>
        {views.map(({ id, label: name }) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={`view-tab${view === id ? " is-active" : ""}${detached.has(id) ? " is-detached" : ""}`}
            data-tip={detached.has(id) ? t.workspace.inOwnWindow(name) : undefined}
            onClick={() => onView(id)}
          >
            {name}
          </button>
        ))}
      </div>
      {overflow.hidden.length > 0 && (
        <button
          className="icon-button view-more"
          data-testid="sidebar-more-views"
          aria-label={t.workspace.moreViews(overflow.hidden.length)}
          data-tip={t.workspace.moreViews(overflow.hidden.length)}
          aria-haspopup="menu"
          onClick={more}
        >
          <span className="view-more-count">+{overflow.hidden.length}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      )}
    </div>
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
  onShowPeople,
  onShowPlugins,
}: {
  view: SidebarView;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  mediaUrl: string;
  /** Switch the sidebar to People; absent in a view's own window. */
  onShowPeople?: () => void;
  /** Switch the sidebar to Plugins; absent in a view's own window. */
  onShowPlugins?: () => void;
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
  if (view === "people") return <PeoplePanel mediaUrl={mediaUrl} />;
  if (view === "shoot") return <ShootPanel onShowPeople={onShowPeople} onShowPlugins={onShowPlugins} />;
  if (view === "teleprompter") return <TeleprompterPanel />;
  return <PluginsPanel />;
}
