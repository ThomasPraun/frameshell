import { useEffect, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { useAgentTargets } from "../ask/agent-targets.js";
import { connectPanel } from "../connect/store.js";
import {
  FIRST_RUN_STEPS,
  filePaths,
  firstRunKey,
  firstRunState,
} from "../first-run/model.js";
import { useTimelineHistory } from "../history/useHistory.js";
import { t } from "../i18n.js";
import { useProjectKind } from "../preview/useProgram.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";

function readClosed(dir: string): boolean {
  try {
    return localStorage.getItem(firstRunKey(dir)) === "1";
  } catch {
    return false;
  }
}

function writeClosed(dir: string): void {
  try {
    localStorage.setItem(firstRunKey(dir), "1");
  } catch {
    // Private storage off: the checklist shows again next time, nothing else depends on it.
  }
}

/**
 * "Getting started n/4" in the status bar of a video project (#787): a popover with the four steps from a new project
 * to an exported video, each ticked from what the project shows, with a link to its page on frameshell.dev. Hidden
 * for good once closed or once every step is done.
 */
export function FirstRun({ project }: { project: ProjectView }) {
  const image = useProjectKind() === "image";
  const [closed, setClosed] = useState(() => readClosed(project.dir));
  if (image || closed) return null;
  return (
    <FirstRunChecklist
      project={project}
      onClose={() => {
        writeClosed(project.dir);
        setClosed(true);
      }}
    />
  );
}

/** Whether an AI app is connected; read again whenever Connect your AI closes and when the window gets focus. */
function useAiConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      void window.frameshell.agents.apps().then(
        ({ apps }) => live && setConnected(apps.some((app) => app.connected)),
        () => undefined,
      );
    read();
    const off = connectPanel.subscribe(
      () => connectPanel.get() === null && read(),
    );
    window.addEventListener("focus", read);
    return () => {
      live = false;
      off();
      window.removeEventListener("focus", read);
    };
  }, []);
  return connected;
}

/** The project's file paths, read again when a file under `exports/` changes. */
function useProjectFiles(): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      void window.frameshell.files.tree().then(
        (tree) => live && setFiles(filePaths(tree)),
        () => undefined,
      );
    read();
    const off = window.frameshell.files.onChanged(
      (paths) => paths.some((path) => path.startsWith("exports/")) && read(),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  return files;
}

function FirstRunChecklist({
  project,
  onClose,
}: {
  project: ProjectView;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const aiConnected = useAiConnected();
  const { targets } = useAgentTargets();
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const { history } = useTimelineHistory(SELECTION_TIMELINE);
  const files = useProjectFiles();
  const read = view !== null && history !== null;
  const state = firstRunState({
    aiConnected: aiConnected || targets.length > 0,
    clips:
      view?.tracks.reduce((sum, track) => sum + track.clips.length, 0) ?? 0,
    authors: history?.transactions.map((tx) => tx.author) ?? [],
    files,
  });
  const finished = read && state.done === FIRST_RUN_STEPS.length;
  useEffect(() => {
    if (finished) onClose();
  }, [finished, onClose]);
  if (!read || finished) return null;
  const strings = t.firstRun;
  return (
    <span className="status-details first-run">
      <button
        className="status-item first-run-button"
        aria-expanded={open}
        data-testid="first-run"
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {strings.button(state.done, FIRST_RUN_STEPS.length)}
      </button>
      {open && (
        <div
          className="first-run-list"
          role="dialog"
          aria-label={strings.title}
          data-testid="first-run-list"
        >
          <h3>{strings.title}</h3>
          <ol>
            {state.steps.map(({ step, done }) => (
              <li
                key={step}
                className={done ? "is-done" : undefined}
                data-step={step}
                data-done={done ? "true" : "false"}
              >
                <span className="first-run-mark" aria-hidden="true">
                  {done ? "✓" : ""}
                </span>
                <span className="first-run-text">
                  {strings.steps[step]}
                  {done && (
                    <span className="sr-only">{` (${strings.done})`}</span>
                  )}
                </span>
                {!done && step === "connect" && (
                  <button
                    className="link"
                    onClick={() => {
                      setOpen(false);
                      connectPanel.open(window, project.name);
                    }}
                  >
                    {strings.connect}
                  </button>
                )}
                {!done && (
                  <a
                    className="link"
                    href={strings.stepUrls[step]}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {strings.howTo}
                  </a>
                )}
              </li>
            ))}
          </ol>
          <div className="first-run-actions">
            <a
              className="link"
              href={strings.guideUrl}
              target="_blank"
              rel="noreferrer"
            >
              {strings.guide}
            </a>
            <button
              className="link"
              data-testid="first-run-close"
              onClick={onClose}
            >
              {strings.close}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
