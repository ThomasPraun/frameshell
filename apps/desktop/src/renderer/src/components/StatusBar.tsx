import type { ProjectView } from "../../../shared/api.js";

/**
 * Bottom strip: which daemon serves the project, which terminal session CLI
 * calls are attributed to, and a transient `notice` (e.g. why "Ask agent" did nothing).
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
      {session && (
        <span className="status-item" data-testid="active-session" title="FRAMESHELL_SESSION of the active terminal">
          {session}
        </span>
      )}
    </footer>
  );
}
