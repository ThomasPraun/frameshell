import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { ProjectView } from "../../../shared/api.js";
import {
  type DetachablePanel,
  type Layout,
  type PanelId,
  type SidebarView,
  resizePanel,
  setCenterSplit,
  togglePanel,
} from "../../../shared/layout.js";
import { askAgent, composeReference } from "../ask/ask-agent.js";
import { usePanelWindow } from "../panel-window.js";
import { transport } from "../preview/transport.js";
import { selection } from "../selection.js";
import { ContextMenuHost } from "./ContextMenu.js";
import { DockedElsewhere } from "./DetachControls.js";
import { type UiHost, uiLink, useUiLink } from "../ui-link.js";
import { EditorArea } from "./EditorArea.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { PanelWindow } from "./PanelWindow.js";
import { SIDEBAR_VIEWS, Sidebar, SidebarWindow } from "./Sidebar.js";
import { Splitter } from "./Splitter.js";
import { StatusBar } from "./StatusBar.js";
import { type AgentTerminal, TerminalPanel } from "./TerminalPanel.js";
import { TimelinePanel } from "./TimelinePanel.js";
import { TRANSCRIPT_TAB, type TranscriptFocus } from "./TranscriptView.js";
import { isTranscriptPath } from "../transcript/useTranscripts.js";
import { elementOf, listenEverywhere, windowOf } from "../windows.js";

const SAVE_DELAY_MS = 300;
/** How long an "Ask agent" notice stays in the status bar, ms. */
const NOTICE_MS = 5000;
const isMac = navigator.userAgent.includes("Mac");

/** Panels of the project window, as `data-panel` names them: what Cmd/Ctrl+Shift+Enter maximizes. */
type WorkspacePanel = "sidebar" | "preview" | "editor" | "timeline" | "terminal";

/** Keyboard toggles; Mod = Cmd on macOS, Ctrl elsewhere. */
const SHORTCUTS: Record<string, PanelId> = { b: "sidebar", j: "timeline", "\\": "terminal" };

/**
 * Project window: SPEC §10 layout with resizable, collapsible, per-project
 * persisted panels. Any panel can move to its own window (ADR 0012): the
 * preview, the timeline, the editor, each sidebar view and each terminal tab.
 * The slot left says so and brings the panel back. Which panels are detached
 * is global and kept by main, so the project opens with them where they
 * were. Cmd/Ctrl+Shift+Enter maximizes the focused panel in place.
 */
export function Workspace({ project }: { project: ProjectView }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [transcriptFocus, setTranscriptFocus] = useState<TranscriptFocus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dragBase = useRef<Layout | null>(null);
  const centerRow = useRef<HTMLDivElement>(null);
  const terminals = useRef<AgentTerminal>(null);
  const terminalCollapsed = useRef(false);
  terminalCollapsed.current = layout?.panels.terminal.collapsed ?? false;
  const [detached, setDetached] = useState<ReadonlySet<DetachablePanel>>(new Set());
  const setPanelDetached = useCallback(
    (panel: DetachablePanel, out: boolean) =>
      setDetached((current) => {
        if (current.has(panel) === out) return current;
        const next = new Set(current);
        if (out) next.add(panel);
        else next.delete(panel);
        return next;
      }),
    [],
  );
  const previewWindow = usePanelWindow(detached.has("preview") ? "preview" : null, `Preview — ${project.name}`, () =>
    setPanelDetached("preview", false),
  );
  const editorWindow = usePanelWindow(detached.has("editor") ? "editor" : null, `Editor — ${project.name}`, () =>
    setPanelDetached("editor", false),
  );
  const detachedViews = useMemo(
    () => new Set(SIDEBAR_VIEWS.map(({ id }) => id).filter((view) => detached.has(view))) as ReadonlySet<SidebarView>,
    [detached],
  );
  const [maximized, setMaximized] = useState<WorkspacePanel | null>(null);

  // Cmd/Ctrl+Shift+Enter: the panel holding the focus, else the one last clicked, fills the window; again restores.
  // A detached panel's window holds that panel alone: there the key does nothing.
  useEffect(() => {
    let last: WorkspacePanel | null = null;
    const onPointer = (event: PointerEvent) => (last = panelAt(event.target) ?? last);
    const onKey = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || !event.shiftKey || event.altKey || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (windowOf(event.target) !== window) return;
      const panel = panelAt(event.target) ?? last;
      setMaximized((current) => (current ? null : panel));
    };
    window.addEventListener("pointerdown", onPointer, true);
    const offKeys = listenEverywhere("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      offKeys();
    };
  }, []);

  // A maximized panel that leaves its slot (detached, collapsed) gives the window back to the others.
  useEffect(() => {
    if (!maximized || !layout) return;
    const collapsed = maximized in layout.panels && layout.panels[maximized as PanelId].collapsed;
    const gone = (maximized === "preview" || maximized === "editor" || maximized === "timeline") && detached.has(maximized);
    if (collapsed || gone) setMaximized(null);
  }, [maximized, layout, detached]);

  useEffect(() => {
    void window.frameshell.panels.detached().then((panels) => setDetached(new Set(panels)));
  }, [project.dir]);

  useEffect(() => {
    void window.frameshell.layout.load().then(setLayout);
  }, [project.dir]);

  // Clip ids and times belong to one project: another project starts with nothing selected, at 0, and so does leaving this one.
  useEffect(() => {
    selection.clear();
    transport.seek(0);
    return () => {
      selection.clear();
      transport.seek(0);
    };
  }, [project.dir]);

  // Persist after the user stops changing things.
  useEffect(() => {
    if (!layout) return;
    const timer = setTimeout(() => window.frameshell.layout.save(layout), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [layout]);

  const toggle = useCallback((id: PanelId) => setLayout((current) => current && togglePanel(current, id)), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // "Ask agent" (SPEC decision 21): type the selection's reference into the target terminal (ADR 0012), unsent.
  useEffect(() => {
    let asking = false;
    return askAgent.install(() => {
      if (asking) return;
      asking = true;
      void composeReference()
        .then(({ lines, warning }) => {
          if (lines.length === 0) {
            setNotice("Select clips, words, a time range, a file, a scene, or pick in the preview (I) to ask the agent about.");
            return;
          }
          terminals.current?.type(lines, () => {
            if (terminalCollapsed.current) toggle("terminal");
          });
          setNotice(warning);
        })
        .finally(() => (asking = false));
    });
  }, [toggle]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "l" && askKeyApplies(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        askAgent.run();
        return;
      }
      const panel = SHORTCUTS[event.key.toLowerCase()];
      if (!panel) return;
      event.preventDefault();
      event.stopPropagation();
      toggle(panel);
    };
    return listenEverywhere("keydown", onKey, true);
  }, [toggle]);

  const openFile = useCallback((path: string) => {
    setTabs((current) => (current.includes(path) ? current : [...current, path]));
    setActive(path);
  }, []);

  // The explorer opens transcript files in the transcript view; its "Open JSON" opens the file itself.
  const browseFile = useCallback(
    (path: string) => {
      if (!isTranscriptPath(path)) return openFile(path);
      openFile(TRANSCRIPT_TAB);
      setTranscriptFocus({ path });
    },
    [openFile],
  );

  // The transcript view from anywhere: Mod+Shift+T, View > Transcript, the timeline header, the tab strip.
  const showTranscript = useCallback(() => openFile(TRANSCRIPT_TAB), [openFile]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || !event.shiftKey || event.key.toLowerCase() !== "t") return;
      event.preventDefault();
      event.stopPropagation();
      showTranscript();
    };
    const offKeys = listenEverywhere("keydown", onKey, true);
    const offMenu = window.frameshell.menu.onCommand((command) => {
      if (command === "showTranscript") showTranscript();
    });
    return () => {
      offKeys();
      offMenu();
    };
  }, [showTranscript]);

  // What the agent sees of this window (`ui_state`) and how it navigates it. Commands commit synchronously,
  // so the state the agent gets back already shows the opened tab or panel.
  const editorState = useRef({ active, tabs });
  editorState.current = { active, tabs };
  useEffect(() => uiLink.changed(), [active, tabs]);
  const host = useMemo<UiHost>(
    () => ({
      editor: () => editorState.current,
      openFile: (path) => flushSync(() => browseFile(path)),
      showHistory: () =>
        flushSync(() =>
          setLayout((current) => {
            if (!current) return current;
            const shown = current.panels.sidebar.collapsed ? togglePanel(current, "sidebar") : current;
            return { ...shown, sidebarView: "history" };
          }),
        ),
    }),
    [browseFile],
  );
  useUiLink(host);

  const closeFile = useCallback((path: string) => {
    setTabs((current) => {
      const index = current.indexOf(path);
      const next = current.filter((tab) => tab !== path);
      setActive((was) => (was === path ? (next[Math.min(index, next.length - 1)] ?? null) : was));
      return next;
    });
  }, []);

  if (!layout) return <div className="boot" />;
  const { sidebar, terminal, timeline } = layout.panels;

  /** Drag handlers for a panel edge; `sign` maps pointer offset onto panel growth. */
  const edge = (id: PanelId, sign: 1 | -1) => ({
    onDragStart: () => (dragBase.current = layout),
    onDrag: (offset: number) => {
      const base = dragBase.current;
      if (base) setLayout(resizePanel(base, id, base.panels[id].size + sign * offset));
    },
    onDragEnd: () => (dragBase.current = null),
  });

  /** `data-panel` and the maximized class of a panel's slot. */
  const slot = (panel: WorkspacePanel) => ({
    "data-panel": panel,
    className: `panel ${panel}${panel === "terminal" ? "-panel" : ""}${maximized === panel ? " is-maximized" : ""}`,
  });

  return (
    <div className={`workspace${maximized ? " is-maximized" : ""}`} data-maximized={maximized ?? undefined}>
      <header className="titlebar drag">
        <span className="titlebar-project">{project.name}</span>
        <span className="titlebar-path">{project.dir}</span>
      </header>

      <div className="main-row">
        {sidebar.collapsed ? (
          <CollapsedRail side="left" label="Show sidebar" onExpand={() => toggle("sidebar")} />
        ) : (
          <>
            <div {...slot("sidebar")} style={{ flexBasis: sidebar.size }}>
              <Sidebar
                view={layout.sidebarView}
                onView={(view) => setLayout({ ...layout, sidebarView: view })}
                onCollapse={() => toggle("sidebar")}
                onOpenFile={browseFile}
                activeFile={active}
                detached={detachedViews}
                onDetach={setPanelDetached}
              />
            </div>
            <Splitter orientation="vertical" label="Resize sidebar" {...edge("sidebar", 1)} />
          </>
        )}

        <div className="center-column">
          <div className="center-row" ref={centerRow}>
            <div {...slot("preview")} style={{ flexBasis: `${layout.centerSplit * 100}%` }}>
              {detached.has("preview") ? (
                <DockedElsewhere title="Preview" onBringBack={() => setPanelDetached("preview", false)} />
              ) : (
                <PreviewPanel project={project} detached={false} onDetach={() => setPanelDetached("preview", true)} />
              )}
            </div>
            {previewWindow &&
              createPortal(
                <div className="panel preview">
                  <PreviewPanel project={project} detached onDetach={() => setPanelDetached("preview", false)} />
                </div>,
                previewWindow,
              )}
            <Splitter
              orientation="vertical"
              label="Resize preview and editor"
              onDragStart={() => (dragBase.current = layout)}
              onDrag={(offset) => {
                const base = dragBase.current;
                const width = centerRow.current?.clientWidth ?? 1;
                if (base) setLayout(setCenterSplit(base, base.centerSplit + offset / width));
              }}
              onDragEnd={() => (dragBase.current = null)}
            />
            <div {...slot("editor")}>
              <EditorArea
                tabs={tabs}
                active={active}
                onActivate={setActive}
                onClose={closeFile}
                onOpenFile={openFile}
                transcriptFocus={transcriptFocus}
                detached={detached.has("editor")}
                target={editorWindow}
                onDetach={(out) => setPanelDetached("editor", out)}
              />
            </div>
          </div>
          {detached.has("timeline") ? (
            <div className="panel timeline">
              <DockedElsewhere compact title="Timeline" onBringBack={() => setPanelDetached("timeline", false)} />
            </div>
          ) : (
            <>
              {!timeline.collapsed && <Splitter orientation="horizontal" label="Resize timeline" {...edge("timeline", -1)} />}
              <div {...slot("timeline")} style={{ height: timeline.collapsed ? undefined : timeline.size }}>
                <TimelinePanel
                  collapsed={timeline.collapsed}
                  onToggle={() => toggle("timeline")}
                  onShowTranscript={showTranscript}
                  onDetach={() => setPanelDetached("timeline", true)}
                />
              </div>
            </>
          )}
          {detached.has("timeline") && (
            <PanelWindow panel="timeline" title={`Timeline — ${project.name}`} onClosed={() => setPanelDetached("timeline", false)}>
              <div className="panel timeline">
                <TimelinePanel collapsed={false} onShowTranscript={showTranscript} detached onDetach={() => setPanelDetached("timeline", false)} />
              </div>
            </PanelWindow>
          )}
        </div>

        {/* Terminals stay mounted while collapsed: shells and agents keep running. */}
        {!terminal.collapsed && <Splitter orientation="vertical" label="Resize terminal" {...edge("terminal", -1)} />}
        {terminal.collapsed && <CollapsedRail side="right" label="Show terminal" onExpand={() => toggle("terminal")} />}
        <div {...slot("terminal")} style={terminal.collapsed ? { display: "none" } : { flexBasis: terminal.size }}>
          <TerminalPanel
            ref={terminals}
            projectName={project.name}
            visible={!terminal.collapsed}
            onCollapse={() => toggle("terminal")}
            onActiveSession={setActiveSession}
          />
        </div>
      </div>

      <StatusBar
        project={project}
        activeFile={active === TRANSCRIPT_TAB ? "Transcript" : active}
        session={activeSession}
        notice={notice}
      />
      {SIDEBAR_VIEWS.filter(({ id }) => detached.has(id)).map(({ id, label }) => (
        <PanelWindow key={id} panel={id} title={`${label} — ${project.name}`} onClosed={() => setPanelDetached(id, false)}>
          <SidebarWindow view={id} onDock={() => setPanelDetached(id, false)} onOpenFile={browseFile} activeFile={active} />
        </PanelWindow>
      ))}
      <ContextMenuHost />
    </div>
  );
}

/** The workspace panel `target` is in, from its slot's `data-panel`; null outside every panel. */
function panelAt(target: EventTarget | null): WorkspacePanel | null {
  return (elementOf(target)?.closest("[data-panel]")?.getAttribute("data-panel") as WorkspacePanel | null | undefined) ?? null;
}

/**
 * Whether Cmd/Ctrl+L at `target` is "Ask agent". Monaco runs it as its own
 * action (it knows the scene under the caret); in a terminal on Linux and
 * Windows, Ctrl+L stays the shell's clear-screen.
 */
function askKeyApplies(target: EventTarget | null): boolean {
  const element = elementOf(target);
  if (!element) return true;
  if (element.closest(".monaco-editor")) return false;
  return isMac || !element.closest(".xterm");
}

function CollapsedRail({ side, label, onExpand }: { side: "left" | "right"; label: string; onExpand: () => void }) {
  return (
    <button className={`rail rail-${side}`} aria-label={label} title={label} onClick={onExpand}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={side === "left" ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5"} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  );
}
