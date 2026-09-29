import { useEffect, useState } from "react";
import type { OpenOutcome } from "../../../shared/api.js";

/** First screen of a window with no project: open a folder, reopen a recent one, or create a project. */
export function Welcome({ onOutcome }: { onOutcome: (outcome: OpenOutcome) => void }) {
  const [recent, setRecent] = useState<string[]>([]);
  const [notProject, setNotProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.frameshell.project.recent().then(setRecent);
  }, []);

  const run = async (action: () => Promise<OpenOutcome>) => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await action();
      if (outcome.status === "not-a-project") setNotProject(outcome.dir);
      else if (outcome.status === "error") setError(outcome.message);
      else setNotProject(null);
      onOutcome(outcome);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome drag">
      <div className="welcome-card no-drag">
        <FrameMark />
        <h1>Frameshell</h1>
        <p className="welcome-lede">Open a project folder. Your agent works in the terminal, you review on the timeline.</p>
        <button className="button primary" disabled={busy} onClick={() => void run(window.frameshell.project.openFolder)}>
          Open folder…
        </button>

        {notProject && (
          <div className="welcome-notice" role="status">
            <p>
              <code>{notProject}</code> has no <code>frameshell.json</code> yet.
            </p>
            <button className="button" disabled={busy} onClick={() => void run(() => window.frameshell.project.init(notProject))}>
              Create a project here
            </button>
          </div>
        )}
        {error && (
          <p className="welcome-error" role="alert">
            {error}
          </p>
        )}

        {recent.length > 0 && (
          <section className="welcome-recent" aria-label="Recent projects">
            <h2>Recent</h2>
            <ul>
              {recent.map((dir) => (
                <li key={dir}>
                  <button className="link" disabled={busy} onClick={() => void run(() => window.frameshell.project.open(dir))}>
                    <span className="recent-name">{dir.split(/[\\/]/).filter(Boolean).pop()}</span>
                    <span className="recent-path">{dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

/** Logo: a frame whose inner edge is a cursor, the product in one glyph. */
function FrameMark() {
  return (
    <svg className="frame-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="3" y="7" width="34" height="26" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <rect x="11" y="15" width="3" height="10" fill="var(--accent)" />
    </svg>
  );
}
