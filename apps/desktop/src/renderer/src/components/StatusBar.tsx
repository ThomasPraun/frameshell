import { useEffect, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { useAgentNotice } from "../ui-link.js";

/** How long the last agent navigation stays in the status bar. */
const AGENT_NOTICE_MS = 6_000;

/**
 * Bottom strip: which daemon serves the project, which terminal session CLI
 * calls are attributed to, a transient `notice` (e.g. why "Ask agent" did nothing),
 * and briefly what the agent just did to the view (MCP navigation).
 */
export function StatusBar({
  project,
  activeFile,
  session,
  notice = null,
}: {
  project: ProjectView;
  activeFile: string | null;
  session: string | null;
  notice?: string | null;
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
      <span className="status-item status-notice" role="status" aria-live="polite" data-testid="status-notice">
        {notice ?? ""}
      </span>
      {shown && (
        <span className="status-item status-agent" data-testid="agent-notice" role="status" key={shown.at}>
          {shown.text}
        </span>
      )}
      {session && (
        <span className="status-item" data-testid="active-session" title="FRAMESHELL_SESSION of the active terminal">
          {session}
        </span>
      )}
    </footer>
  );
}
