import { useEffect, useRef, useState } from "react";
import type { ShootScreenSource } from "../../../shared/api.js";
import { t } from "../i18n.js";
import { elapsedLabel, meterFill } from "../shoot/model.js";
import { shoot, useShoot } from "../shoot/recorder.js";

/**
 * Shoot view (ADR 0024, Spanish UI "Rodaje"): pick a camera, a microphone (the one required source), a screen or
 * window from Frameshell's own list and system audio, each with a live preview or level; then Start and End one
 * continuous session. The recorder lives outside this view ({@link shoot}), so a session keeps recording while the
 * view switches tabs or moves to its own window.
 */
export function ShootPanel() {
  const state = useShoot();
  const [picking, setPicking] = useState(false);
  useEffect(() => shoot.mount(), []);
  const locked = state.phase !== "idle";
  const recording = state.phase === "recording";

  const pickScreens = () => {
    setPicking(true);
    void shoot.loadScreens();
  };
  const choose = (screen: ShootScreenSource | null) => {
    setPicking(false);
    void shoot.selectScreen(screen);
  };

  return (
    <div className="shoot-panel" data-testid="shoot-panel" data-phase={state.phase}>
      <p className="shoot-hint">{t.shoot.intro}</p>
      {state.access === false && (
        <div className="shoot-row">
          <button className="button" onClick={() => void shoot.requestAccess()}>
            {t.shoot.allow}
          </button>
        </div>
      )}
      {state.accessError && <p className="shoot-error">{t.shoot.denied(state.accessError)}</p>}

      <section className="shoot-source">
        <label className="shoot-label">
          {t.shoot.camera}
          <select
            className="shoot-select"
            data-testid="shoot-camera"
            value={state.camera ?? ""}
            disabled={locked}
            onChange={(event) => void shoot.selectCamera(event.target.value || null)}
          >
            <option value="">{t.shoot.noCamera}</option>
            {state.cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.label || camera.id}
              </option>
            ))}
          </select>
        </label>
        {state.cameraStream && <StreamVideo stream={state.cameraStream} label={t.shoot.preview(t.shoot.camera)} testId="shoot-camera-preview" />}
      </section>

      <section className="shoot-source">
        <label className="shoot-label">
          {t.shoot.mic}
          <select
            className="shoot-select"
            data-testid="shoot-mic"
            value={state.mic ?? ""}
            disabled={locked}
            onChange={(event) => void shoot.selectMic(event.target.value || null)}
          >
            {state.mic === null && <option value="">—</option>}
            {state.mics.map((mic) => (
              <option key={mic.id} value={mic.id}>
                {mic.label || mic.id}
              </option>
            ))}
          </select>
        </label>
        <Meter db={state.micLevel} label={t.shoot.level(t.shoot.mic)} testId="shoot-mic-level" />
        {state.mic === null && <p className="shoot-note">{t.shoot.micRequired}</p>}
      </section>

      <section className="shoot-source">
        <div className="shoot-label">
          {t.shoot.screen}
          <span className="shoot-screen-name">{state.screen ? state.screen.name : t.shoot.noScreen}</span>
        </div>
        <div className="shoot-row">
          <button className="button" data-testid="shoot-screen-choose" disabled={locked} onClick={pickScreens}>
            {t.shoot.chooseScreen}
          </button>
          {state.screen && (
            <button className="button" disabled={locked} onClick={() => choose(null)}>
              {t.shoot.noScreen}
            </button>
          )}
        </div>
        {picking && !locked && (
          <div className="shoot-screens" role="listbox" aria-label={t.shoot.screen}>
            <p className="shoot-note">{state.screensError ? t.shoot.screensFailed(state.screensError) : t.shoot.screensHint}</p>
            {state.screens?.map((screen) => (
              <button
                key={screen.id}
                role="option"
                aria-selected={state.screen?.id === screen.id}
                className="shoot-screen"
                data-testid="shoot-screen-option"
                onClick={() => choose(screen)}
              >
                {screen.thumbnail ? <img src={screen.thumbnail} alt="" /> : <span className="shoot-screen-empty" />}
                <span className="shoot-screen-label">
                  {t.shoot.screenKind[screen.kind]}: {screen.name}
                </span>
              </button>
            ))}
          </div>
        )}
        {state.screen && state.screenStream && (
          <StreamVideo stream={state.screenStream} label={t.shoot.preview(state.screen.name)} testId="shoot-screen-preview" />
        )}
        {state.screen?.kind === "screen" && <p className="shoot-note">{t.shoot.protectHint}</p>}
      </section>

      <section className="shoot-source">
        <label className="shoot-check" title={t.shoot.systemAudioHint}>
          <input
            type="checkbox"
            data-testid="shoot-system"
            checked={state.systemAudio}
            disabled={locked || state.support !== "available"}
            onChange={(event) => void shoot.setSystemAudio(event.target.checked)}
          />
          {t.shoot.systemAudio}
        </label>
        {state.support && state.support !== "available" && <p className="shoot-note">{t.shoot.systemAudioMissing[state.support]}</p>}
        {state.systemAudio && <Meter db={state.systemLevel} label={t.shoot.level(t.shoot.systemAudio)} testId="shoot-system-level" />}
        {state.systemSilent && (
          <p className="shoot-warning" role="status" data-testid="shoot-system-silent">
            {t.shoot.systemSilent}
          </p>
        )}
      </section>

      <div className="shoot-row">
        {recording || state.phase === "ending" ? (
          <button className="button primary" data-testid="shoot-end" disabled={!recording} onClick={() => void shoot.end()}>
            {recording ? t.shoot.end : t.shoot.ending}
          </button>
        ) : (
          <button
            className="button primary"
            data-testid="shoot-start"
            disabled={locked || state.mic === null}
            onClick={() => void shoot.start()}
          >
            {state.phase === "starting" ? t.shoot.starting : t.shoot.start}
          </button>
        )}
        {recording && state.startedAt !== null && <Elapsed since={state.startedAt} />}
      </div>

      {state.error && (
        <p className="shoot-error" role="alert">
          {t.shoot.failed(state.error)}
        </p>
      )}
      {state.finished && (
        <div className="shoot-done" role="status" data-testid="shoot-finished" data-group={state.finished.group ?? ""}>
          <p>{state.finished.recovered ? t.shoot.recovered(state.finished.folder) : t.shoot.saved(state.finished.folder, state.finished.files.length)}</p>
          {state.finished.group ? (
            <p>{t.shoot.grouped}</p>
          ) : (
            !state.finished.files.some((file) => /\/(camera|screen)\.\w+$/.test(file)) && <p>{t.shoot.noGroup}</p>
          )}
          {state.finished.warnings.map((warning) => (
            <p key={warning} className="shoot-note">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** A live stream in a muted `<video>`: the picture only, never the sound. */
function StreamVideo({ stream, label, testId }: { stream: MediaStream; label: string; testId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={video} className="shoot-preview" data-testid={testId} aria-label={label} muted playsInline disablePictureInPicture />;
}

function Meter({ db, label, testId }: { db: number; label: string; testId: string }) {
  const fill = meterFill(db);
  return (
    <div
      className="shoot-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(Math.max(-60, db))}
      data-testid={testId}
      data-db={Math.round(db)}
    >
      <span className="shoot-meter-fill" style={{ width: `${fill * 100}%` }} />
    </div>
  );
}

/** Recording time, ticking on the timers of the window that shows it (ADR 0012). */
function Elapsed({ since }: { since: number }) {
  const span = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const view = span.current?.ownerDocument.defaultView ?? window;
    const timer = view.setInterval(() => setNow(performance.now()), 500);
    return () => view.clearInterval(timer);
  }, []);
  return (
    <span ref={span} className="shoot-elapsed" data-testid="shoot-elapsed">
      <span className="shoot-dot" aria-hidden="true" />
      {t.shoot.recording(elapsedLabel(now - since))}
    </span>
  );
}
