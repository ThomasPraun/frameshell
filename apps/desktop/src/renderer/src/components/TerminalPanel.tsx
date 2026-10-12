import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TerminalInfo } from "../../../shared/api.js";
import { askTarget } from "../ask/ask-target.js";
import { agentInput } from "../ask/reference.js";
import { usePanelWindow } from "../panel-window.js";
import { DetachButton, DockedElsewhere } from "./DetachControls.js";
import { PanelHeader } from "./PanelHeader.js";

/** A tab before its pty exists has no `info` yet. A detached tab shows in a window of its own (ADR 0012). */
interface Tab {
  key: number;
  info: TerminalInfo | null;
  exitCode: number | null;
  detached: boolean;
}

/** How long the Ask agent target's tab flashes, ms. */
const FLASH_MS = 1200;
/** The terminal font: cells are measured with it, so it must be loaded in the view's document first. */
const FONT_FAMILY = '"JetBrains Mono Variable", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const FONT_SIZE = 13;

const THEME = {
  background: "#1a1b1d",
  foreground: "#dcdcd7",
  cursor: "#e3a53c",
  cursorAccent: "#1a1b1d",
  selectionBackground: "#4a4436",
  black: "#2b2c30",
  red: "#e0675f",
  green: "#8fbf7f",
  yellow: "#e3a53c",
  blue: "#7092c4",
  magenta: "#b48acb",
  cyan: "#6fb3b0",
  white: "#dcdcd7",
  brightBlack: "#6b6c70",
  brightRed: "#f0857d",
  brightGreen: "#a9d49a",
  brightYellow: "#f0c068",
  brightBlue: "#8eaede",
  brightMagenta: "#cba4df",
  brightCyan: "#8fcfcc",
  brightWhite: "#f4f4f0",
};

/**
 * Pty output router: one IPC subscription for all views. Output with no view
 * registered is dropped: a view that registers replays it from main
 * (`terminals.attach`).
 */
function useTerminalRouter() {
  const sinks = useRef(new Map<string, (data: string) => void>());
  useEffect(() => window.frameshell.terminals.onData((id, data) => sinks.current.get(id)?.(data)), []);
  return useCallback((id: string, sink: (data: string) => void) => {
    sinks.current.set(id, sink);
    return () => {
      if (sinks.current.get(id) === sink) sinks.current.delete(id);
    };
  }, []);
}

/** What "Ask agent" needs of the terminals. */
export interface AgentTerminal {
  /**
   * Type `lines` at the prompt of the Ask agent target (ADR 0012), without
   * pressing Enter (see `agentInput`): the last focused terminal running an
   * agent, in any window of the project; else the last focused terminal. Its
   * tab flashes; its window is never raised. A docked target becomes the
   * active tab, and `reveal` runs first so a collapsed panel can expand. A
   * tab still starting gets the lines once its shell is up; with no live
   * tab, a new one is opened for them.
   */
  type(lines: readonly string[], reveal: () => void): void;
}

/** A started xterm, as the panel drives it. */
interface ViewHandle {
  type(lines: readonly string[]): void;
}

/**
 * Right column: tabs of real shells. Stays mounted while collapsed so agents
 * keep running. Each tab can move to its own window and back (ADR 0012); its
 * pty lives until the tab is closed, whichever window shows it.
 */
export function TerminalPanel({
  projectName,
  visible,
  onCollapse,
  onActiveSession,
  ref,
}: {
  projectName: string;
  visible: boolean;
  onCollapse: () => void;
  onActiveSession: (session: string | null) => void;
  ref?: Ref<AgentTerminal>;
}) {
  const nextKey = useRef(1);
  const [tabs, setTabs] = useState<Tab[]>(() => [{ key: 0, info: null, exitCode: null, detached: false }]);
  const [active, setActive] = useState(0);
  /** Agent CLI running in each terminal, by terminal id; absent when none. */
  const [agents, setAgents] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [flashing, setFlashing] = useState<number | null>(null);
  const route = useTerminalRouter();
  /** Attached views by tab key. */
  const views = useRef(new Map<number, ViewHandle>());
  /** Lines waiting for a tab's view to attach. */
  const pending = useRef(new Map<number, readonly string[]>());
  /** Each tab's pty, once asked for: created by the first view, attached by every later one. */
  const starts = useRef(new Map<number, Promise<TerminalInfo | null>>());
  /** Tabs closed while their pty was still being created. */
  const closed = useRef(new Set<number>());
  /** Tab keys by focus, most recent last. */
  const focusOrder = useRef<number[]>([]);
  const latest = useRef({ tabs, active, agents });
  latest.current = { tabs, active, agents };

  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = useCallback((key: number) => {
    clearTimeout(flashTimer.current);
    setFlashing(key);
    flashTimer.current = setTimeout(() => setFlashing(null), FLASH_MS);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      type(lines, reveal) {
        const { tabs: current, active: key, agents: running } = latest.current;
        const target = askTarget(current, key, running, focusOrder.current);
        if (!target) {
          reveal();
          const added = nextKey.current++;
          pending.current.set(added, lines);
          setTabs((was) => [...was, { key: added, info: null, exitCode: null, detached: false }]);
          setActive(added);
          return;
        }
        if (!target.detached) {
          reveal();
          setActive(target.key);
        }
        flash(target.key);
        const view = views.current.get(target.key);
        if (view) view.type(lines);
        else pending.current.set(target.key, lines);
      },
    }),
    [flash],
  );

  const start = useCallback((key: number, size: { cols: number; rows: number }) => {
    let started = starts.current.get(key);
    if (!started) {
      started = window.frameshell.terminals.create(size).then((info) => {
        if (closed.current.has(key)) {
          window.frameshell.terminals.kill(info.id);
          return null;
        }
        setTabs((current) => current.map((tab) => (tab.key === key ? { ...tab, info } : tab)));
        return info;
      });
      starts.current.set(key, started);
    }
    return started;
  }, []);

  const register = useCallback((key: number, view: ViewHandle) => {
    views.current.set(key, view);
    const lines = pending.current.get(key);
    pending.current.delete(key);
    if (lines) view.type(lines);
    return () => {
      if (views.current.get(key) === view) views.current.delete(key);
    };
  }, []);

  const focused = useCallback((key: number) => {
    focusOrder.current = [...focusOrder.current.filter((other) => other !== key), key];
  }, []);

  useEffect(
    () =>
      window.frameshell.terminals.onAgent((id, agent) =>
        setAgents((current) => {
          const next = new Map(current);
          if (agent) next.set(id, agent);
          else next.delete(id);
          return next;
        }),
      ),
    [],
  );

  useEffect(
    () =>
      window.frameshell.terminals.onExit((id, exitCode) =>
        setTabs((current) => current.map((tab) => (tab.info?.id === id ? { ...tab, exitCode } : tab))),
      ),
    [],
  );

  const activeTab = tabs.find((tab) => tab.key === active);
  useEffect(() => onActiveSession(activeTab?.info?.session ?? null), [activeTab?.info?.session, onActiveSession]);

  const add = () => {
    const key = nextKey.current++;
    setTabs((current) => [...current, { key, info: null, exitCode: null, detached: false }]);
    setActive(key);
  };

  const close = (key: number) => {
    const tab = tabs.find((candidate) => candidate.key === key);
    if (tab?.info) window.frameshell.terminals.kill(tab.info.id);
    else closed.current.add(key);
    starts.current.delete(key);
    pending.current.delete(key);
    focusOrder.current = focusOrder.current.filter((other) => other !== key);
    const index = tabs.findIndex((candidate) => candidate.key === key);
    const rest = tabs.filter((candidate) => candidate.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[Math.min(index, rest.length - 1)]?.key ?? -1);
  };

  const setDetached = useCallback((key: number, detached: boolean) => {
    setTabs((current) => current.map((tab) => (tab.key === key ? { ...tab, detached } : tab)));
    if (!detached) setActive(key);
  }, []);

  const label = (tab: Tab, index: number) => {
    const agent = tab.info ? agents.get(tab.info.id) : undefined;
    return tab.info ? `${agent ?? tab.info.shell} ${index + 1}` : "starting…";
  };

  const view = (tab: Tab, shown: boolean) => (
    <TerminalView
      key={tab.key}
      tabKey={tab.key}
      start={start}
      register={register}
      route={route}
      onFocus={focused}
      active={shown}
      exitCode={tab.exitCode}
    />
  );

  return (
    <>
      <PanelHeader
        onCollapse={onCollapse}
        collapseLabel="Hide terminal"
        collapseSide="right"
        actions={
          <DetachButton
            name="terminal"
            detached={false}
            disabled={!activeTab || activeTab.detached}
            onClick={() => setDetached(active, true)}
            testId="terminal-detach"
          />
        }
      >
        <div className="terminal-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((tab, index) => {
            const agent = tab.info ? agents.get(tab.info.id) : undefined;
            const where = tab.detached ? ", in its own window" : "";
            return (
              <div
                key={tab.key}
                role="tab"
                aria-selected={tab.key === active}
                data-session={tab.info?.session}
                data-agent={agent}
                data-flashing={flashing === tab.key || undefined}
                className={`terminal-tab${tab.key === active ? " is-active" : ""}${tab.exitCode !== null ? " has-exited" : ""}${agent ? " is-agent" : ""}${tab.detached ? " is-detached" : ""}${flashing === tab.key ? " is-flashing" : ""}`}
                title={tab.info ? `${agent ? `Agent ${agent} in session` : "Session"} ${tab.info.session}${where}` : undefined}
                onClick={() => setActive(tab.key)}
              >
                <span>{label(tab, index)}</span>
                <button
                  className="terminal-tab-close"
                  aria-label="Close terminal"
                  onClick={(event) => {
                    event.stopPropagation();
                    close(tab.key);
                  }}
                />
              </div>
            );
          })}
          <button className="icon-button" aria-label="New terminal" title="New terminal" onClick={add}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </PanelHeader>
      <div className="terminal-stack">
        {tabs.map((tab, index) =>
          !tab.detached ? (
            view(tab, visible && tab.key === active)
          ) : (
            tab.key === active && (
              <DockedElsewhere key={tab.key} title={`Terminal ${label(tab, index)}`} onBringBack={() => setDetached(tab.key, false)} />
            )
          ),
        )}
        {tabs.length === 0 && (
          <div className="empty terminal-empty">
            <button className="button" onClick={add}>
              New terminal
            </button>
          </div>
        )}
      </div>
      {tabs.map(
        (tab, index) =>
          tab.detached && (
            <TerminalWindow
              key={tab.key}
              label={label(tab, index)}
              title={`${label(tab, index)} — ${projectName}`}
              flashing={flashing === tab.key}
              onDock={() => setDetached(tab.key, false)}
            >
              {view(tab, true)}
            </TerminalWindow>
          ),
      )}
    </>
  );
}

/** A detached tab's window: its name, a way back, and its view. Closing the window docks the tab back. */
function TerminalWindow({
  label,
  title,
  flashing,
  onDock,
  children,
}: {
  label: string;
  title: string;
  flashing: boolean;
  onDock: () => void;
  children: ReactNode;
}) {
  const host = usePanelWindow("terminal", title, onDock);
  if (!host) return null;
  return createPortal(
    <div className="panel terminal-window">
      <PanelHeader actions={<DetachButton name="terminal" detached onClick={onDock} testId="terminal-detach" />}>
        <span className={`panel-title terminal-window-title${flashing ? " is-flashing" : ""}`} data-flashing={flashing || undefined}>
          {label}
        </span>
      </PanelHeader>
      <div className="terminal-stack">{children}</div>
    </div>,
    host,
  );
}

/**
 * One xterm showing one tab's pty. The first view of a tab creates the pty;
 * every view, the first included, replays its recent output from main before
 * going live, so a tab moved to another window keeps its screen. Unmounting
 * leaves the pty running: only closing the tab kills it. Refits on every size
 * change so TUIs redraw at the right grid. Timing, observers and fonts come
 * from the window the view lives in (ADR 0012).
 */
function TerminalView({
  tabKey,
  start,
  register,
  route,
  onFocus,
  active,
  exitCode,
}: {
  tabKey: number;
  /** The tab's pty: created on the first call, the same one after. Null once the tab is closed. */
  start: (key: number, size: { cols: number; rows: number }) => Promise<TerminalInfo | null>;
  /** Called once the view is attached; returns its unregister function. */
  register: (key: number, view: ViewHandle) => () => void;
  route: (id: string, sink: (data: string) => void) => () => void;
  onFocus: (key: number) => void;
  active: boolean;
  exitCode: number | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const doc = element.ownerDocument;
    const view = doc.defaultView ?? window;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const xterm = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = "11";
    xterm.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    term.current = xterm;
    fit.current = fitAddon;

    const begin = async () => {
      // Cell size depends on the web font: measure after it loads in this view's document.
      await doc.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`).catch(() => []);
      await doc.fonts.ready;
      if (disposed) return;
      xterm.open(element);
      fitAddon.fit();
      const info = await start(tabKey, { cols: xterm.cols, rows: xterm.rows });
      if (!info || disposed) return;
      // Output sent before the replay is in it: drop it until then, so nothing shows twice.
      let live = false;
      cleanups.push(route(info.id, (data) => live && xterm.write(data)));
      const replay = await window.frameshell.terminals.attach(info.id);
      if (disposed) return;
      if (replay) xterm.write(replay);
      live = true;
      xterm.onData((data) => window.frameshell.terminals.write(info.id, data));
      xterm.onResize(({ cols, rows }) => window.frameshell.terminals.resize(info.id, cols, rows));
      // The last view's grid may have been another size: the program redraws for this one.
      window.frameshell.terminals.resize(info.id, xterm.cols, xterm.rows);
      setAttached(true);
      if (activeRef.current) xterm.focus();
      cleanups.push(
        register(tabKey, {
          type(lines) {
            // paste(): what a user's paste does, wrapped in bracketed-paste marks when the program asked for them.
            xterm.paste(agentInput(lines, xterm.modes.bracketedPasteMode));
            xterm.focus();
          },
        }),
      );
    };
    void begin();

    let frame = 0;
    const observer = new view.ResizeObserver(() => {
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(() => {
        // Hidden tabs measure 0x0; fitting them would shrink the pty to nothing.
        if (element.offsetWidth > 0 && element.offsetHeight > 0 && xterm.element) fitAddon.fit();
      });
    });
    observer.observe(element);

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      observer.disconnect();
      view.cancelAnimationFrame(frame);
      xterm.dispose();
    };
  }, [start, register, route, tabKey]);

  useEffect(() => {
    if (!active) return;
    const view = host.current?.ownerDocument.defaultView ?? window;
    view.requestAnimationFrame(() => {
      if (term.current?.element) {
        fit.current?.fit();
        term.current.focus();
      }
    });
  }, [active]);

  useEffect(() => {
    if (attached && exitCode !== null) term.current?.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
  }, [attached, exitCode]);

  return (
    <div
      className="terminal-view"
      ref={host}
      hidden={!active}
      data-testid="terminal-view"
      onFocus={() => onFocus(tabKey)}
    />
  );
}
