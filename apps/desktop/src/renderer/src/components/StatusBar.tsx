import { useEffect, useState } from "react";
import type { ProjectSetup, ProjectView } from "../../../shared/api.js";
import { t } from "../i18n.js";
import { useAgentNotice } from "../ui-link.js";

/** How long the last agent navigation stays in the status bar. */
const AGENT_NOTICE_MS = 6_000;

/**
 * Bottom strip: which daemon serves the project, which terminal session CLI
 * calls are attributed to, a transient `notice` (e.g. why "Ask agent" did nothing),
 * the background `setup` of a new project (#188), and briefly what the agent
 * just did to the view (MCP navigation), and the connected agents while the
 * terminal panel is closed (ADR 0025 decision 8).
 */
export function StatusBar({
  project,
  activeFile,
  session,
  notice = null,
  setup = null,
  agentTargets = [],
  onShowTerminal,
}: {
  project: ProjectView;
  activeFile: string | null;
  session: string | null;
  notice?: string | null;
  setup?: ProjectSetup | null;
  /** Connected agents to list; the caller passes them only while the terminal panel is closed. */
  agentTargets?: readonly string[];
  /** Reopens the terminal panel from the agents entry. */
  onShowTerminal?: () => void;
}) {
  const agent = useAgentNotice();
  const [shown, setShown] = useState(agent);
  useEffect(() => {
    setShown(agent);
    if (!agent) return;
    const timer = setTimeout(() => setShown(null), Math.max(0, agent.at + AGENT_NOTICE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [agent]);
  return (
    <footer className="statusbar">
      <span className="status-item" title={project.daemon.socketPath}>
        <span className="status-dot" aria-hidden="true" />
        frameshelld {project.daemon.version}, pid {project.daemon.pid}
      </span>
      {activeFile && <span className="status-item">{activeFile}</span>}
      <span className="status-spacer" />
      {setup && (
        <span className={`status-item status-setup is-${setup.state}`} role="status" data-testid="project-setup" title={setup.detail ?? setup.message}>
          {setup.state === "running" && (
            <span className="setup-bar" aria-hidden="true">
              <span style={{ width: setup.fraction === null ? undefined : `${Math.round(setup.fraction * 100)}%` }} className={setup.fraction === null ? "is-indeterminate" : ""} />
            </span>
          )}
          {setup.message}
          {setup.state === "running" && setup.fraction !== null && ` ${Math.round(setup.fraction * 100)}%`}
        </span>
      )}
      <span className="status-item status-notice" role="status" aria-live="polite" data-testid="status-notice">
        {notice ?? ""}
      </span>
      {shown && (
        <span className="status-item status-agent" data-testid="agent-notice" role="status" key={shown.at}>
          {shown.text}
        </span>
      )}
      {agentTargets.length > 0 && (
        <button className="status-item status-agents" data-testid="connected-agents" title={t.workspace.connectedAgentsTitle} onClick={onShowTerminal}>
          {t.workspace.connectedAgents(agentTargets.join(", "))}
        </button>
      )}
      {session && (
        <span className="status-item" data-testid="active-session" title={t.workspace.activeSessionTitle}>
          {session}
        </span>
      )}
    </footer>
  );
}
