import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.js";
import { elapsedLabel } from "../shoot/model.js";
import { shoot, useShoot } from "../shoot/recorder.js";
import { type CutOutcome, type CutTake, currentScene, cutOutcome, sceneTitle } from "../shoot/takes-model.js";
import { useTakes } from "../shoot/takes.js";

/**
 * Where the takes are, for the person reading (ADR 0024): ready for T, the take being recorded with its running time,
 * and the outcome of the take cut last as it arrives. Shown in the Shoot view and, while recording, the teleprompter.
 * Reads the takes store and the recorder only.
 */
export function TakeStatus({ place, mirror = false }: { place: "shoot" | "teleprompter"; mirror?: boolean }) {
  const takes = useTakes();
  const recorder = useShoot();
  const recording = recorder.phase === "recording";
  const { status, open } = takes;
  // A take cut in an earlier session is old news once the next one records.
  const last = takes.last && (!recording || takes.last.session === shoot.clock()?.session) ? takes.last : null;
  if (place === "teleprompter" && !recording && recorder.phase !== "ending") return null;
  if (!takes.script || !status) return null;
  if (!recording && !last) {
    return place === "shoot" ? (
      <p className="take-status-hint" data-testid="take-status-hint">
        {t.shoot.takeKeys}
      </p>
    ) : null;
  }
  const scene = currentScene(status, takes.picked);
  const outcome = last && <Outcome last={last} outcome={cutOutcome(status, last)} place={place} />;
  return (
    <div className={`take-status is-${place}${mirror ? " is-mirrored" : ""}`} data-testid="take-status" data-state={open && recording ? "open" : recording ? "ready" : "ended"}>
      {open && recording ? (
        <>
          <span className="take-status-main is-open" data-testid="take-status-open">
            <span className="take-status-dot" aria-hidden="true" />
            {t.shoot.takeLive(open.number, sceneTitle(status, open.scene))}
            <TakeTimer start={open.start} />
          </span>
          <span className="take-status-key">{t.shoot.cutKey}</span>
          {outcome}
        </>
      ) : recording && !last ? (
        <span className="take-status-main">{scene !== null && t.shoot.takeReady(sceneTitle(status, scene))}</span>
      ) : (
        <>
          {outcome}
          {recording && scene !== null && <span className="take-status-key">{t.shoot.takeKey(sceneTitle(status, scene))}</span>}
        </>
      )}
    </div>
  );
}

function Outcome({ last, outcome, place }: { last: CutTake; outcome: CutOutcome; place: "shoot" | "teleprompter" }) {
  const n = last.number;
  const text =
    outcome.kind === "analyzing"
      ? t.shoot.takeAnalyzing(n)
      : outcome.kind === "short"
        ? t.shoot.takeShort(n)
        : outcome.kind === "failed"
          ? t.shoot.takeFailed(n, outcome.problem)
          : outcome.differences === 0
            ? t.shoot.takeClean(n)
            : place === "teleprompter"
              ? t.teleprompter.takeDifferences(n, outcome.differences)
              : t.shoot.takeDifferences(n, outcome.differences);
  const tone = outcome.kind === "analyzed" ? (outcome.differences === 0 ? "clean" : "differences") : outcome.kind;
  // Keyed by take and outcome, so each new outcome is announced and its highlight plays once.
  return (
    <span key={`${last.number}-${last.scene}-${tone}`} className={`take-status-outcome is-${tone}`} role="status" aria-live="polite" data-testid="take-status-outcome" data-outcome={tone} title={text}>
      {text}
    </span>
  );
}

/** Time since T on the session clock, ticking on the timers of the window that shows it (ADR 0012). */
function TakeTimer({ start }: { start: number }) {
  const span = useRef<HTMLSpanElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const view = span.current?.ownerDocument.defaultView ?? window;
    const timer = view.setInterval(() => tick((count) => count + 1), 250);
    return () => view.clearInterval(timer);
  }, []);
  const elapsed = (shoot.clock()?.seconds ?? start) - start;
  return (
    <span ref={span} className="take-status-time" data-testid="take-status-time">
      {elapsedLabel(elapsed * 1000)}
    </span>
  );
}
