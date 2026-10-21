import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioOrientation, OpenOutcome, VideoProjectPlan } from "../../../shared/api.js";
import { useFileDrop } from "../file-drop.js";
import { rich, t } from "../i18n.js";

/** First screen of a window with no project: start from a video, audio or image file, open a folder, reopen a recent one, or create a project. */
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
        if (refused.length > 0) setError(t.welcome.notVideo(refused.map(fileName).join(", ")));
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
        <p className="welcome-lede">{t.welcome.lede}</p>
        {dragging && <p className="welcome-drop">{t.welcome.dropHere}</p>}

        {plan ? (
          <NewFromVideo
            plan={plan}
            busy={busy}
            onPlan={setPlan}
            onError={setError}
            onCancel={() => setPlan(null)}
            onCreate={(mode, name, transcribe, orientation) =>
              void run(() => window.frameshell.project.fromVideos({ ...plan, name }, mode, { transcribe, orientation }))
            }
          />
        ) : (
          <div className="welcome-actions">
            <button className="button primary" disabled={busy} onClick={() => void chooseVideos()}>
              {t.welcome.newFromVideo}
            </button>
            <button className="button" disabled={busy} onClick={() => void run(window.frameshell.project.openFolder)}>
              {t.welcome.openFolder}
            </button>
          </div>
        )}

        {notProject && (
          <div className="welcome-notice" role="status">
            <p>{rich(t.welcome.notProject, { dir: <code>{notProject}</code>, file: <code>frameshell.json</code> })}</p>
            <button className="button" disabled={busy} onClick={() => void run(() => window.frameshell.project.init(notProject))}>
              {t.welcome.createHere}
            </button>
          </div>
        )}
        {error && (
          <p className="welcome-error" role="alert">
            {error}
          </p>
        )}

        {recent.length > 0 && !plan && (
          <section className="welcome-recent" aria-label={t.welcome.recentProjects}>
            <h2>{t.welcome.recent}</h2>
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

/** Confirmation of a project made from videos, audio or images (ADR 0013, 0015, 0017): name, place, and copy or use in place when it matters. */
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
  onCreate: (mode: "copy" | "link", name: string, transcribe: boolean, orientation: AudioOrientation) => void;
}) {
  const [name, setName] = useState(plan.name);
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [transcribe, setTranscribe] = useState(true);
  const [orientation, setOrientation] = useState<AudioOrientation>("landscape");
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
  const videos = names.length <= 3 ? names.join(", ") : t.welcome.andMore(names.slice(0, 2).join(", "), names.length - 2);
  return (
    <form
      className="welcome-new"
      aria-label={t.welcome.form}
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(mode, name, transcribe, orientation);
      }}
    >
      <p className="welcome-new-source">{videos}</p>
      <label className="welcome-field">
        <span>{t.welcome.projectName}</span>
        <input
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void replan({ name })}
          spellCheck={false}
        />
      </label>
      <div className="welcome-field">
        <span>{t.welcome.folder}</span>
        <div className="welcome-place">
          {/* Cut from the start, so the project folder at the end stays visible. */}
          <code title={plan.dir}>
            <bdi dir="ltr">{plan.dir}</bdi>
          </code>
          <button type="button" className="link" disabled={busy} onClick={() => void changeParent()}>
            {t.welcome.change}
          </button>
        </div>
      </div>

      {plan.imageOnly && !plan.existing && <p className="welcome-hint">{t.welcome.imageHint}</p>}

      {plan.audioOnly && !plan.existing && (
        <fieldset className="welcome-mode">
          <legend>{t.welcome.frameLegend}</legend>
          <label>
            <input type="radio" name="frame" checked={orientation === "landscape"} onChange={() => setOrientation("landscape")} />
            {t.welcome.frameLandscape}
          </label>
          <label>
            <input type="radio" name="frame" checked={orientation === "portrait"} onChange={() => setOrientation("portrait")} />
            {t.welcome.framePortrait}
          </label>
        </fieldset>
      )}

      {plan.existing ? (
        <p className="welcome-hint">{t.welcome.exists}</p>
      ) : plan.askMode ? (
        <fieldset className="welcome-mode">
          <legend>{t.welcome.modeLegend}</legend>
          <label>
            <input type="radio" name="mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
            {t.welcome.modeCopy(formatBytes(plan.totalBytes))}
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "link"} onChange={() => setMode("link")} />
            {t.welcome.modeLink}
          </label>
        </fieldset>
      ) : (
        <p className="welcome-hint">{t.welcome.copyHint}</p>
      )}

      {!plan.existing && !plan.imageOnly && (
        <label className="welcome-check">
          <input type="checkbox" checked={transcribe} onChange={(event) => setTranscribe(event.target.checked)} />
          <span>
            {t.welcome.transcribe}
            <small>{t.welcome.transcribeHint}</small>
          </span>
        </label>
      )}

      <div className="welcome-actions">
        <button type="submit" className="button primary" disabled={busy}>
          {plan.existing ? t.welcome.openProject : busy ? t.welcome.creating : t.welcome.createProject}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t.welcome.cancel}
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
