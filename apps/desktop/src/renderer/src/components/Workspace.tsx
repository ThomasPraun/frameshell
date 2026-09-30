import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { type Layout, type PanelId, resizePanel, setCenterSplit, togglePanel } from "../../../shared/layout.js";
import { askAgent, composeReference } from "../ask/ask-agent.js";
import { transport } from "../preview/transport.js";
import { selection } from "../selection.js";
import { ContextMenuHost } from "./ContextMenu.js";
import { EditorArea } from "./EditorArea.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { Sidebar } from "./Sidebar.js";
import { Splitter } from "./Splitter.js";
import { StatusBar } from "./StatusBar.js";
import { type AgentTerminal, TerminalPanel } from "./TerminalPanel.js";
import { TimelinePanel } from "./TimelinePanel.js";
import { TRANSCRIPT_TAB, type TranscriptFocus } from "./TranscriptView.js";
import { isTranscriptPath } from "../transcript/useTranscripts.js";

const SAVE_DELAY_MS = 300;
/** How long an "Ask agent" notice stays in the status bar, ms. */
const NOTICE_MS = 5000;
const isMac = navigator.userAgent.includes("Mac");

/** Keyboard toggles; Mod = Cmd on macOS, Ctrl elsewhere. */
const SHORTCUTS: Record<string, PanelId> = { b: "sidebar", j: "timeline", "\\": "terminal" };

/** Project window: SPEC §10 layout with resizable, collapsible, per-project persisted panels. */
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

  // "Ask agent" (SPEC decision 21): type the selection's reference into the active terminal, unsent.
  useEffect(() => {
    let asking = false;
    return askAgent.install(() => {
      if (asking) return;
      asking = true;
      void composeReference()
        .then(({ lines, warning }) => {
          if (lines.length === 0) {
            setNotice("Select clips, words, a time range, a file, a scene or a preview region to ask the agent about.");
            return;
          }
          if (terminalCollapsed.current) toggle("terminal");
          terminals.current?.type(lines);
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

  return (
    <div className="workspace">
      <header className="titlebar drag">
        <span className="titlebar-project">{project.name}</span>
        <span className="titlebar-path">{project.dir}</span>
      </header>

      <div className="main-row">
        {sidebar.collapsed ? (
          <CollapsedRail side="left" label="Show sidebar" onExpand={() => toggle("sidebar")} />
        ) : (
          <>
            <div className="panel sidebar" style={{ flexBasis: sidebar.size }}>
              <Sidebar
                view={layout.sidebarView}
                onView={(view) => setLayout({ ...layout, sidebarView: view })}
                onCollapse={() => toggle("sidebar")}
                onOpenFile={browseFile}
                activeFile={active}
              />
            </div>
            <Splitter orientation="vertical" label="Resize sidebar" {...edge("sidebar", 1)} />
          </>
        )}

        <div className="center-column">
          <div className="center-row" ref={centerRow}>
            <div className="panel preview" style={{ flexBasis: `${layout.centerSplit * 100}%` }}>
              <PreviewPanel project={project} />
            </div>
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
            <div className="panel editor">
              <EditorArea
                tabs={tabs}
                active={active}
                onActivate={setActive}
                onClose={closeFile}
                onOpenFile={openFile}
                transcriptFocus={transcriptFocus}
              />
            </div>
          </div>
          {!timeline.collapsed && <Splitter orientation="horizontal" label="Resize timeline" {...edge("timeline", -1)} />}
          <div className="panel timeline" style={{ height: timeline.collapsed ? undefined : timeline.size }}>
            <TimelinePanel collapsed={timeline.collapsed} onToggle={() => toggle("timeline")} />
          </div>
        </div>

        {/* Terminals stay mounted while collapsed: shells and agents keep running. */}
        {!terminal.collapsed && <Splitter orientation="vertical" label="Resize terminal" {...edge("terminal", -1)} />}
        {terminal.collapsed && <CollapsedRail side="right" label="Show terminal" onExpand={() => toggle("terminal")} />}
        <div
          className="panel terminal-panel"
          style={terminal.collapsed ? { display: "none" } : { flexBasis: terminal.size }}
        >
          <TerminalPanel
            ref={terminals}
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
      <ContextMenuHost />
    </div>
  );
}

/**
 * Whether Cmd/Ctrl+L at `target` is "Ask agent". Monaco runs it as its own
 * action (it knows the scene under the caret); in a terminal on Linux and
 * Windows, Ctrl+L stays the shell's clear-screen.
 */
function askKeyApplies(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(".monaco-editor")) return false;
  return isMac || !target.closest(".xterm");
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
