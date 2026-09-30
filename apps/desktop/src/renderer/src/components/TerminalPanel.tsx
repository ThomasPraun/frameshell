import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalInfo } from "../../../shared/api.js";
import { agentInput } from "../ask/reference.js";
import { PanelHeader } from "./PanelHeader.js";

/** A tab before its pty exists has no `info` yet. */
interface Tab {
  key: number;
  info: TerminalInfo | null;
  exitCode: number | null;
}

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
 * Pty output router: one IPC subscription for all tabs. Output that arrives
 * before a view registers (a shell's first prompt racing the create reply) is buffered.
 */
function useTerminalRouter() {
  const sinks = useRef(new Map<string, (data: string) => void>());
  const early = useRef(new Map<string, string>());
  useEffect(
    () =>
      window.frameshell.terminals.onData((id, data) => {
        const sink = sinks.current.get(id);
        if (sink) sink(data);
        else early.current.set(id, (early.current.get(id) ?? "") + data);
      }),
    [],
  );
  return useCallback((id: string, sink: ((data: string) => void) | null) => {
    if (!sink) {
      sinks.current.delete(id);
      return;
    }
    sinks.current.set(id, sink);
    const buffered = early.current.get(id);
    early.current.delete(id);
    if (buffered) sink(buffered);
  }, []);
}

/** What "Ask agent" needs of the terminals: type into the active one. */
export interface AgentTerminal {
  /**
   * Focus the active terminal and type `lines` at its prompt without
   * pressing Enter (see `agentInput`). A tab still starting gets them once
   * its shell is up; with no live tab, a new one is opened for them.
   */
  type(lines: readonly string[]): void;
}

/** A started xterm, as the panel drives it. */
interface ViewHandle {
  type(lines: readonly string[]): void;
}

/** Right column: tabs of real shells. Stays mounted while collapsed so agents keep running. */
export function TerminalPanel({
  visible,
  onCollapse,
  onActiveSession,
  ref,
}: {
  visible: boolean;
  onCollapse: () => void;
  onActiveSession: (session: string | null) => void;
  ref?: Ref<AgentTerminal>;
}) {
  const nextKey = useRef(1);
  const [tabs, setTabs] = useState<Tab[]>(() => [{ key: 0, info: null, exitCode: null }]);
  const [active, setActive] = useState(0);
  /** Agent CLI running in each terminal, by terminal id; absent when none. */
  const [agents, setAgents] = useState<ReadonlyMap<string, string>>(() => new Map());
  const route = useTerminalRouter();
  /** Started views by tab key. */
  const views = useRef(new Map<number, ViewHandle>());
  /** Lines waiting for a starting tab's shell. */
  const pending = useRef(new Map<number, readonly string[]>());
  const latest = useRef({ tabs, active });
  latest.current = { tabs, active };

  useImperativeHandle(
    ref,
    () => ({
      type(lines) {
        const { tabs: current, active: key } = latest.current;
        const tab = current.find((candidate) => candidate.key === key);
        const view = views.current.get(key);
        if (tab && tab.exitCode === null && view) return view.type(lines);
        if (tab && tab.exitCode === null) {
          pending.current.set(key, lines);
          return;
        }
        const added = nextKey.current++;
        pending.current.set(added, lines);
        setTabs((was) => [...was, { key: added, info: null, exitCode: null }]);
        setActive(added);
      },
    }),
    [],
  );

  const registerView = useCallback((key: number, view: ViewHandle | null) => {
    if (!view) {
      views.current.delete(key);
      pending.current.delete(key);
      return;
    }
    views.current.set(key, view);
    const lines = pending.current.get(key);
    pending.current.delete(key);
    if (lines) view.type(lines);
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
    setTabs((current) => [...current, { key, info: null, exitCode: null }]);
    setActive(key);
  };

  const close = (key: number) => {
    const tab = tabs.find((candidate) => candidate.key === key);
    if (tab?.info) window.frameshell.terminals.kill(tab.info.id);
    const index = tabs.findIndex((candidate) => candidate.key === key);
    const rest = tabs.filter((candidate) => candidate.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[Math.min(index, rest.length - 1)]?.key ?? -1);
  };

  return (
    <>
      <PanelHeader onCollapse={onCollapse} collapseLabel="Hide terminal" collapseSide="right">
        <div className="terminal-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((tab, index) => {
            const agent = tab.info ? agents.get(tab.info.id) : undefined;
            return (
              <div
                key={tab.key}
                role="tab"
                aria-selected={tab.key === active}
                data-session={tab.info?.session}
                data-agent={agent}
                className={`terminal-tab${tab.key === active ? " is-active" : ""}${tab.exitCode !== null ? " has-exited" : ""}${agent ? " is-agent" : ""}`}
                title={tab.info ? `${agent ? `Agent ${agent} in session` : "Session"} ${tab.info.session}` : undefined}
                onClick={() => setActive(tab.key)}
              >
                <span>{tab.info ? `${agent ?? tab.info.shell} ${index + 1}` : "starting…"}</span>
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
        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            tabKey={tab.key}
            register={registerView}
            active={visible && tab.key === active}
            exitCode={tab.exitCode}
            route={route}
            onReady={(info) =>
              setTabs((current) => current.map((candidate) => (candidate.key === tab.key ? { ...candidate, info } : candidate)))
            }
          />
        ))}
        {tabs.length === 0 && (
          <div className="empty terminal-empty">
            <button className="button" onClick={add}>
              New terminal
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** One xterm bound to one pty. Refits on every size change so TUIs redraw at the right grid. */
function TerminalView({
  tabKey,
  register,
  active,
  exitCode,
  route,
  onReady,
}: {
  tabKey: number;
  /** Called with the started view, and with null when it goes away. */
  register: (key: number, view: ViewHandle | null) => void;
  active: boolean;
  exitCode: number | null;
  route: (id: string, sink: ((data: string) => void) | null) => void;
  onReady: (info: TerminalInfo) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const xterm = new Terminal({
      fontFamily: '"JetBrains Mono Variable", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
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

    const start = async () => {
      // Cell size depends on the web font: measure after it loads.
      await document.fonts.ready;
      if (disposed) return;
      xterm.open(element);
      fitAddon.fit();
      const info = await window.frameshell.terminals.create({ cols: xterm.cols, rows: xterm.rows });
      if (disposed) {
        window.frameshell.terminals.kill(info.id);
        return;
      }
      idRef.current = info.id;
      route(info.id, (data) => xterm.write(data));
      xterm.onData((data) => window.frameshell.terminals.write(info.id, data));
      xterm.onResize(({ cols, rows }) => window.frameshell.terminals.resize(info.id, cols, rows));
      onReadyRef.current(info);
      xterm.focus();
      register(tabKey, {
        type(lines) {
          // paste(): what a user's paste does, wrapped in bracketed-paste marks when the program asked for them.
          xterm.paste(agentInput(lines, xterm.modes.bracketedPasteMode));
          xterm.focus();
        },
      });
    };
    void start();

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Hidden tabs measure 0x0; fitting them would shrink the pty to nothing.
        if (element.offsetWidth > 0 && element.offsetHeight > 0 && xterm.element) fitAddon.fit();
      });
    });
    observer.observe(element);

    return () => {
      disposed = true;
      register(tabKey, null);
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (idRef.current) {
        route(idRef.current, null);
        window.frameshell.terminals.kill(idRef.current);
      }
      xterm.dispose();
    };
  }, [route, register, tabKey]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (term.current?.element) {
        fit.current?.fit();
        term.current.focus();
      }
    });
  }, [active]);

  useEffect(() => {
    if (exitCode !== null) term.current?.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
  }, [exitCode]);

  return <div className="terminal-view" ref={host} hidden={!active} data-testid="terminal-view" />;
}
