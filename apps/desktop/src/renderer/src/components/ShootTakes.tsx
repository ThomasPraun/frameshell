import { useEffect } from "react";
import { t } from "../i18n.js";
import { useShoot } from "../shoot/recorder.js";
import { type DeviationInfo, currentScene, lineMarks } from "../shoot/takes-model.js";
import { takes, useTakes } from "../shoot/takes.js";

/**
 * The Shoot view's takes (ADR 0023, 0024): the shoot script, its scenes with their state, and the current scene's
 * chosen take as tracked changes against the script lines, each deviation accepted on its own or the whole take at
 * once. While recording, T starts a take at the current scene (again: record it again) and C cuts it.
 */
export function ShootTakes() {
  const state = useTakes();
  const recorder = useShoot();
  useEffect(() => takes.mount(), []);
  const recording = recorder.phase === "recording";
  const { status, check } = state;
  const scene = currentScene(status, state.picked);
  const sceneStatus = status?.scenes.find((candidate) => candidate.slug === scene) ?? null;
  const sceneLines = check?.scenes.find((candidate) => candidate.slug === scene)?.lines ?? [];
  const chosen = status?.takes.find((take) => take.id === sceneStatus?.chosen) ?? null;
  const deviations = chosen?.deviations.filter((deviation) => deviation.scene === scene) ?? [];
  const pending = deviations.filter((deviation) => !deviation.accepted);
  const transcribing = status?.takes.some((take) => take.state === "transcribing") ?? false;

  if (state.scripts === null) return null;
  if (state.scripts.length === 0) return <p className="shoot-note">{t.shoot.noScript}</p>;

  return (
    <section className="shoot-takes" data-testid="shoot-takes">
      <label className="shoot-label">
        {t.shoot.script}
        <select className="shoot-select" data-testid="shoot-script" value={state.script ?? ""} onChange={(event) => void takes.selectScript(event.target.value)}>
          {state.scripts.map((script) => (
            <option key={script} value={script}>
              {script.replace(/^scripts\//, "")}
            </option>
          ))}
        </select>
      </label>

      {status && (
        <ol className="shoot-scenes" aria-label={t.shoot.scenes}>
          {status.scenes.map((candidate) => (
            <li key={candidate.slug}>
              <button
                className={`shoot-scene is-${candidate.state}${candidate.slug === scene ? " is-current" : ""}`}
                data-testid="shoot-scene"
                data-scene={candidate.slug}
                data-state={candidate.state}
                aria-current={candidate.slug === scene}
                onClick={() => takes.pick(candidate.slug)}
              >
                <span className="shoot-scene-title">{candidate.title}</span>
                <span className="shoot-scene-state">
                  {candidate.state === "deviations" ? t.shoot.pending(candidate.pending) : t.shoot.sceneState[candidate.state]}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {recording && (
        <div className="shoot-row">
          <button className="button" data-testid="shoot-take" onClick={() => void takes.take()}>
            {state.open ? t.shoot.again : t.shoot.newTake}
          </button>
          <button className="button" data-testid="shoot-cut" disabled={!state.open} onClick={() => void takes.cut()}>
            {t.shoot.cut}
          </button>
          {state.open && (
            <span className="shoot-take-open" data-testid="shoot-take-open">
              {t.shoot.takeOpen(status?.scenes.find((candidate) => candidate.slug === state.open!.scene)?.title ?? state.open.scene)}
            </span>
          )}
        </div>
      )}
      {transcribing && <p className="shoot-note">{t.shoot.transcribing}</p>}

      {sceneStatus && (
        <div className="shoot-current" data-testid="shoot-current" data-scene={sceneStatus.slug}>
          <h4 className="shoot-current-title">{sceneStatus.title}</h4>
          {sceneStatus.takes.length > 0 ? (
            <label className="shoot-label">
              {t.shoot.chosenTake}
              <select
                className="shoot-select"
                data-testid="shoot-chosen"
                value={sceneStatus.picked ? (sceneStatus.chosen ?? "") : ""}
                onChange={(event) => void takes.choose(sceneStatus.slug, event.target.value || null)}
              >
                <option value="">{t.shoot.newest}</option>
                {sceneStatus.takes.map((id, index) => (
                  <option key={id} value={id}>
                    {t.shoot.takeName(index + 1, time(status?.takes.find((take) => take.id === id)?.recordedAt))}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="shoot-note">{t.shoot.noTake}</p>
          )}
          {chosen?.problem && chosen.state !== "transcribing" && <p className="shoot-error">{t.shoot.failed(chosen.problem)}</p>}
          <div className="shoot-lines">
            {sceneLines.map((line) => {
              const own = deviations.filter((deviation) => deviation.line === line.line);
              const { marks } = lineMarks(line.words, own);
              return (
                <div key={line.line} className="shoot-line" data-testid="shoot-line" data-line={line.line}>
                  {line.speaker && <span className="shoot-speaker">{line.speaker}: </span>}
                  {line.words.length === 0 ? (
                    <span className="shoot-cue">{line.text}</span>
                  ) : (
                    marks.map((mark, i) =>
                      mark.kind === "missing" ? (
                        <del key={i} className="shoot-missing">{mark.text}</del>
                      ) : mark.kind === "heard" ? (
                        <ins key={i} className="shoot-heard">{mark.text}</ins>
                      ) : (
                        <span key={i}>{mark.text}</span>
                      ),
                    ).flatMap((node, i) => (i === 0 ? [node] : [" ", node]))
                  )}
                  {own.map((deviation) => (
                    <DeviationRow key={deviation.id} take={chosen!.id} deviation={deviation} />
                  ))}
                </div>
              );
            })}
            {deviations
              .filter((deviation) => deviation.line === null || !sceneLines.some((line) => line.line === deviation.line))
              .map((deviation) => (
                <DeviationRow key={deviation.id} take={chosen!.id} deviation={deviation} />
              ))}
          </div>
          <div className="shoot-row">
            {chosen && pending.length > 0 && (
              <button className="button" data-testid="shoot-accept-all" onClick={() => void takes.accept(chosen.id)}>
                {t.shoot.acceptTake}
              </button>
            )}
            <button className="button" data-testid="shoot-next" onClick={() => takes.nextScene()}>
              {t.shoot.nextScene}
            </button>
          </div>
        </div>
      )}
      {state.error && <p className="shoot-error">{t.shoot.failed(state.error)}</p>}
    </section>
  );
}

function DeviationRow({ take, deviation }: { take: string; deviation: DeviationInfo }) {
  return (
    <div className={`shoot-deviation${deviation.accepted ? " is-accepted" : ""}`} data-testid="shoot-deviation" data-kind={deviation.kind} data-accepted={deviation.accepted}>
      <span className="shoot-deviation-text">{t.shoot.deviation[deviation.kind](deviation.expected, deviation.heard)}</span>
      {deviation.accepted ? (
        <span className="shoot-deviation-done">{t.shoot.accepted}</span>
      ) : (
        <button className="button" data-testid="shoot-accept" onClick={() => void takes.accept(take, [deviation.id])}>
          {t.shoot.accept}
        </button>
      )}
    </div>
  );
}

/** Clock time of an ISO time, as the person's locale writes it; empty when unknown. */
function time(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
