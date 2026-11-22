import { DEFAULT_TRANSCRIPTION_PROVIDER } from "@frameshell/schema";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.js";
import { transcriptionInstallCommand } from "../plugins/install-command.js";
import { mediaSrc } from "../preview/media-src.js";
import { showSidebarView } from "../sidebar-request.js";
import { type LineRow, checkNote, differenceText, lineCounts, lineRows, progressText, refusalText } from "../voiceover/model.js";
import { type DialogState, type PlaceForm, voiceoverDialog } from "../voiceover/store.js";
import { useModal } from "./modal.js";

const said = t.voiceover;

/**
 * The app's voiceover dialog (ADR 0034 decision 22), drawn in the page: progress with Stop while the takes are
 * said, the misread report, and the form that places them on the timeline. Mount once, in the project window; a
 * dialog opened from a detached panel's window is drawn there through a portal.
 */
export function VoiceoverDialogHost({ mediaUrl }: { /** Base URL of the project's media, to play the takes; null with no project. */ mediaUrl: string | null }) {
  const state = useSyncExternalStore(voiceoverDialog.subscribe, voiceoverDialog.get);
  useEffect(() => {
    if (!state) stopTake();
  }, [state === null]);
  if (!state) return null;
  const element = <VoiceoverDialog state={state} mediaUrl={mediaUrl} />;
  return state.view === window ? element : createPortal(element, state.view.document.body);
}

function VoiceoverDialog({ state, mediaUrl }: { state: DialogState; mediaUrl: string | null }) {
  const title = useId();
  const box = useRef<HTMLDivElement>(null);
  const { run, place } = state;
  const running = run.kind === "running";
  const onKeyDown = useModal(box, state.view, () => {
    if (!running) voiceoverDialog.close();
  });
  const name = state.script.split("/").pop() ?? state.script;
  return (
    <div className="voiceover-backdrop" data-testid="voiceover-backdrop">
      <div
        ref={box}
        className="voiceover-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        data-testid="voiceover-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={title} className="voiceover-title">
          {said.title(name)}
        </h2>
        <RunSection state={state} mediaUrl={mediaUrl} />
        {place && <PlaceSection place={place} />}
        <div className="voiceover-actions">
          <button className="button" data-testid="voiceover-close" disabled={running} onClick={() => voiceoverDialog.close()}>
            {said.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunSection({ state, mediaUrl }: { state: DialogState; mediaUrl: string | null }) {
  const { run } = state;
  switch (run.kind) {
    case "none":
      return null;
    case "getting":
      return <p className="voiceover-note">{said.getting}</p>;
    case "choose": {
      const megabytes = Math.max(1, Math.round(run.bytes / 1_000_000));
      return (
        <section className="voiceover-section" data-testid="voiceover-choose">
          <h3 className="voiceover-heading">{said.chooseTitle}</h3>
          <p className="voiceover-note">{said.chooseBody(megabytes)}</p>
          <div className="voiceover-actions">
            <button className="button primary" data-testid="voiceover-check" onClick={() => void voiceoverDialog.choose(true)}>
              {said.generateAndCheck(megabytes)}
            </button>
            <button className="button" data-testid="voiceover-skip-check" onClick={() => void voiceoverDialog.choose(false)}>
              {said.generateOnly}
            </button>
          </div>
        </section>
      );
    }
    case "running":
      return (
        <section className="voiceover-section" data-testid="voiceover-progress" aria-live="polite">
          <p className="voiceover-note">{run.stopping ? said.stopping : progressText(run.progress, said)}</p>
          {run.progress?.fraction != null ? <progress max={1} value={run.progress.fraction} /> : <progress />}
          {run.nothingStopped && (
            <p className="voiceover-note" role="status" data-testid="voiceover-nothing-stopped">
              {said.nothingStopped}
            </p>
          )}
          <div className="voiceover-actions">
            <button className="button" data-testid="voiceover-stop" disabled={run.stopping} onClick={() => void voiceoverDialog.stop()}>
              {said.stop}
            </button>
          </div>
        </section>
      );
    case "stopped":
      return (
        <section className="voiceover-section">
          <p className="voiceover-note" role="status" data-testid="voiceover-stopped">
            {said.stopped(run.kept)}
          </p>
          <p className="voiceover-hint">{said.continueHint}</p>
          <div className="voiceover-actions">
            <button className="button primary" data-testid="voiceover-continue" onClick={() => void voiceoverDialog.continueRun()}>
              {said.continueRun}
            </button>
          </div>
        </section>
      );
    case "voice":
      return (
        <section className="voiceover-section" data-testid="voiceover-voice">
          <h3 className="voiceover-heading">{said.noVoiceTitle}</h3>
          {run.missing && <p className="voiceover-note">{said.noVoiceMissing(run.missing)}</p>}
          {run.available.length > 0 ? (
            <>
              <p className="voiceover-note">{said.chooseVoice}</p>
              <div className="voiceover-form">
                <label htmlFor={`${state.script}-voice`}>{said.voiceLabel}</label>
                <select
                  id={`${state.script}-voice`}
                  className="voiceover-input"
                  data-testid="voiceover-voice-pick"
                  value={run.chosen}
                  onChange={(event) => voiceoverDialog.pickVoice(event.target.value)}
                >
                  {run.available.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="voiceover-actions">
                <button className="button primary" data-testid="voiceover-voice-generate" onClick={() => void voiceoverDialog.generateWithVoice()}>
                  {said.generate}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="voiceover-note">{said.noVoiceBody}</p>
              <div className="voiceover-actions">
                <button
                  className="button primary"
                  data-testid="voiceover-open-plugins"
                  onClick={() => {
                    showSidebarView("plugins");
                    voiceoverDialog.close();
                  }}
                >
                  {said.openPlugins}
                </button>
              </div>
            </>
          )}
        </section>
      );
    case "failed":
      return (
        <section className="voiceover-section" role="alert" data-testid="voiceover-failed">
          <h3 className="voiceover-heading">{said.failed}</h3>
          <p className="voiceover-error">{run.message}</p>
        </section>
      );
    case "report": {
      const { result, asked } = run;
      const counts = lineCounts(result);
      const note = checkNote(result, asked);
      return (
        <section className="voiceover-section" data-testid="voiceover-report">
          <p className="voiceover-note">{said.summary(counts.generated, counts.reused)}</p>
          <p className="voiceover-note" data-testid="voiceover-check-note">
            {note.kind === "checked"
              ? said.checked(note.misread, note.doubtful)
              : note.kind === "unavailable"
                ? said.notCheckedUnavailable(transcriptionInstallCommand(DEFAULT_TRANSCRIPTION_PROVIDER))
                : note.kind === "declined"
                  ? said.notCheckedDeclined
                  : said.notCheckedWhy(note.reason)}
          </p>
          <h3 className="voiceover-heading">{said.linesHeading}</h3>
          <ul className="voiceover-lines">
            {lineRows(result).map((row) => (
              <LineItem key={row.id} row={row} mediaUrl={mediaUrl} />
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <>
              <h3 className="voiceover-heading">{said.warningsHeading}</h3>
              <ul className="voiceover-warnings">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      );
    }
  }
}

/** The take playing in the report, one at a time. */
let playing: { audio: HTMLAudioElement; file: string } | null = null;
const playingListeners = new Set<() => void>();

function stopTake(): void {
  playing?.audio.pause();
  playing = null;
  for (const listener of playingListeners) listener();
}

/** Play the take at `src` (`file` names it), stopping any other; a second press on the same take stops it. */
function toggleTake(file: string, src: string): void {
  if (playing?.file === file) return stopTake();
  stopTake();
  const audio = new Audio(src);
  playing = { audio, file };
  audio.addEventListener("ended", () => playing?.audio === audio && stopTake(), { once: true });
  void audio.play().catch(() => playing?.audio === audio && stopTake());
  for (const listener of playingListeners) listener();
}

function usePlayingTake(): string | null {
  return useSyncExternalStore(
    (listener) => {
      playingListeners.add(listener);
      return () => playingListeners.delete(listener);
    },
    () => playing?.file ?? null,
  );
}

function LineItem({ row, mediaUrl }: { row: LineRow; mediaUrl: string | null }) {
  const on = usePlayingTake() === row.file;
  const label = on ? said.stopLine(row.number) : said.playLine(row.number);
  return (
    <li className={`voiceover-line is-${row.status}`} data-testid={`voiceover-line-${row.id}`} data-status={row.status}>
      <div className="voiceover-line-head">
        {mediaUrl && (
          <button
            className="icon-button"
            data-testid="voiceover-line-play"
            aria-label={label}
            aria-pressed={on}
            data-tip={label}
            onClick={() => toggleTake(row.file, mediaSrc(mediaUrl, row.file))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {on ? <rect x="4.5" y="4.5" width="7" height="7" fill="currentColor" /> : <path d="M5 3.5L12.5 8L5 12.5Z" fill="currentColor" />}
            </svg>
          </button>
        )}
        <span className="voiceover-line-number">{row.number}</span>
        <span className="voiceover-line-text">{row.display}</span>
        <span className="voiceover-line-state">{said.state[row.state]}</span>
        <span className={`voiceover-chip is-${row.status}`}>{said.check[row.status]}</span>
      </div>
      {row.misreads.length > 0 && (
        <ul className="voiceover-misreads">
          {row.misreads.map((misread, index) => (
            <li key={index}>{differenceText(misread, said)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function PlaceSection({ place }: { place: PlaceForm }) {
  const startId = useId();
  const hintId = useId();
  const listId = useId();
  return (
    <section className="voiceover-section" data-testid="voiceover-place">
      <h3 className="voiceover-heading">{said.placeHeading}</h3>
      <p className="voiceover-note">{said.placeHelp}</p>
      <div className="voiceover-form">
        <label htmlFor={startId}>{said.startLabel}</label>
        <input
          id={startId}
          className="voiceover-input"
          data-testid="voiceover-start"
          type="text"
          list={listId}
          value={place.start}
          placeholder={said.startPlaceholder}
          aria-describedby={hintId}
          disabled={place.busy}
          onChange={(event) => voiceoverDialog.edit({ start: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") void voiceoverDialog.submitPlace();
          }}
        />
        <datalist id={listId}>
          {[...new Set(place.markers)].map((marker) => (
            <option key={marker} value={marker} />
          ))}
        </datalist>
        <p id={hintId} className="voiceover-hint">
          {said.startHint}
        </p>
        <label className={`voiceover-check${place.refusal?.kind === "replace" ? " is-asked" : ""}`} data-testid="voiceover-replace-label">
          <input type="checkbox" data-testid="voiceover-replace" checked={place.replace} disabled={place.busy} onChange={(event) => voiceoverDialog.edit({ replace: event.target.checked })} />
          {said.replaceLabel}
        </label>
      </div>
      <div className="voiceover-actions">
        <button className="button primary" data-testid="voiceover-place-go" disabled={place.busy} onClick={() => void voiceoverDialog.submitPlace()}>
          {place.busy ? said.placing : said.place}
        </button>
      </div>
      {place.result && (
        <div role="status" data-testid="voiceover-placed">
          <p className="voiceover-note">{said.placed(place.result.placed.length, place.result.lines.length, place.result.track.name ?? "")}</p>
          {place.result.warnings.length > 0 && (
            <ul className="voiceover-warnings">
              {place.result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {place.refusal && (
        <div role="alert" data-testid="voiceover-place-refused" data-reason={place.refusal.kind}>
          <p className="voiceover-error">{refusalText(place.refusal, said)}</p>
        </div>
      )}
      {place.error && (
        <div role="alert" data-testid="voiceover-place-error">
          <p className="voiceover-error">
            {said.placeFailed}: {place.error}
          </p>
        </div>
      )}
    </section>
  );
}
