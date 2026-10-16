import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenOutcome, VideoProjectPlan } from "../../../shared/api.js";
import { useFileDrop } from "../file-drop.js";

/** First screen of a window with no project: start from a video, open a folder, reopen a recent one, or create a project. */
export function Welcome({ onOutcome }: { onOutcome: (outcome: OpenOutcome) => void }) {
  const [recent, setRecent] = useState<string[]>([]);
  const [notProject, setNotProject] = useState<string | null>(null);
  const [plan, setPlan] = useState<VideoProjectPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.frameshell.project.recent().then(setRecent);
  }, []);

  // Videos opened from the OS (Open with, #184): shown for confirmation like chosen ones.
  useEffect(() => {
    const take = () =>
      void window.frameshell.project.takeOffered().then((offered) => {
        if (offered) {
          setPlan(offered);
          setNotProject(null);
        }
      });
    take();
    return window.frameshell.project.onVideosOffered(take);
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

  const dropped = useCallback(
    async (paths: string[]) => {
      if (busy) return;
      setError(null);
      try {
        const { plan: next, refused } = await window.frameshell.project.planVideos(paths);
        if (next) {
          setPlan(next);
          setNotProject(null);
        }
        if (refused.length > 0) setError(`Not a video: ${refused.map(fileName).join(", ")}`);
      } catch (failure) {
        setError((failure as Error).message);
      }
    },
    [busy],
  );
  const dragging = useFileDrop(useCallback((paths: string[]) => void dropped(paths), [dropped]));

  const chooseVideos = async () => {
    setError(null);
    try {
      const chosen = await window.frameshell.project.chooseVideos();
      if (chosen) {
        setPlan(chosen);
        setNotProject(null);
      }
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <main className={`welcome drag${dragging ? " is-dropping" : ""}`}>
      <div className="welcome-card no-drag">
        <FrameMark />
        <h1>Frameshell</h1>
        <p className="welcome-lede">Start from a video. Your agent edits it from the terminal, you review on the timeline.</p>
        {dragging && <p className="welcome-drop">Drop videos to start a project</p>}

        {plan ? (
          <NewFromVideo
            plan={plan}
            busy={busy}
            onPlan={setPlan}
            onError={setError}
            onCancel={() => setPlan(null)}
            onCreate={(mode, name, transcribe) =>
              void run(() => window.frameshell.project.fromVideos({ ...plan, name }, mode, { transcribe }))
            }
          />
        ) : (
          <div className="welcome-actions">
            <button className="button primary" disabled={busy} onClick={() => void chooseVideos()}>
              New from video…
            </button>
            <button className="button" disabled={busy} onClick={() => void run(window.frameshell.project.openFolder)}>
              Open folder…
            </button>
          </div>
        )}

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

        {recent.length > 0 && !plan && (
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

/** Confirmation of a project made from videos (ADR 0013): name, place, and copy or use in place when it matters. */
function NewFromVideo({
  plan,
  busy,
  onPlan,
  onError,
  onCancel,
  onCreate,
}: {
  plan: VideoProjectPlan;
  busy: boolean;
  onPlan: (plan: VideoProjectPlan) => void;
  onError: (message: string | null) => void;
  onCancel: () => void;
  /** `name` as typed: it may not be replanned yet. */
  onCreate: (mode: "copy" | "link", name: string, transcribe: boolean) => void;
}) {
  const [name, setName] = useState(plan.name);
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [transcribe, setTranscribe] = useState(true);
  // Replans only for the latest edit: a slow answer for an older name must not overwrite a newer one.
  const latest = useRef(0);

  const replan = async (place: { parent?: string; name?: string }) => {
    const ticket = ++latest.current;
    try {
      const { plan: next } = await window.frameshell.project.planVideos(plan.files, { parent: plan.parent, name, ...place });
      if (ticket === latest.current && next) {
        onPlan(next);
        onError(null);
      }
    } catch (failure) {
      if (ticket === latest.current) onError((failure as Error).message);
    }
  };

  const changeParent = async () => {
    const parent = await window.frameshell.project.chooseParent();
    if (parent) await replan({ parent });
  };

  const names = plan.files.map(fileName);
  const videos = names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return (
    <form
      className="welcome-new"
      aria-label="New project from video"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(mode, name, transcribe);
      }}
    >
      <p className="welcome-new-source">{videos}</p>
      <label className="welcome-field">
        <span>Project name</span>
        <input
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void replan({ name })}
          spellCheck={false}
        />
      </label>
      <div className="welcome-field">
        <span>Folder</span>
        <div className="welcome-place">
          {/* Cut from the start, so the project folder at the end stays visible. */}
          <code title={plan.dir}>
            <bdi dir="ltr">{plan.dir}</bdi>
          </code>
          <button type="button" className="link" disabled={busy} onClick={() => void changeParent()}>
            Change…
          </button>
        </div>
      </div>

      {plan.existing ? (
        <p className="welcome-hint">A project for this video already exists in that folder.</p>
      ) : plan.askMode ? (
        <fieldset className="welcome-mode">
          <legend>Your videos stay where they are. The project can:</legend>
          <label>
            <input type="radio" name="mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
            Keep its own copy ({formatBytes(plan.totalBytes)} more disk space)
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "link"} onChange={() => setMode("link")} />
            Use the videos in place (do not move or delete them)
          </label>
        </fieldset>
      ) : (
        <p className="welcome-hint">Your videos stay where they are; the project keeps its own copy.</p>
      )}

      {!plan.existing && (
        <label className="welcome-check">
          <input type="checkbox" checked={transcribe} onChange={(event) => setTranscribe(event.target.checked)} />
          <span>
            Transcribe what is said
            <small>The first time, this downloads the transcription engine and model (about 600 MB).</small>
          </span>
        </label>
      )}

      <div className="welcome-actions">
        <button type="submit" className="button primary" disabled={busy}>
          {plan.existing ? "Open project" : busy ? "Creating…" : "Create project"}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
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
