import { type Program, type VideoSpan, programAt } from "../preview/program.js";
import { rich, t } from "../i18n.js";

type GeneratedSpan = Extract<VideoSpan, { kind: "generated" }>;

/**
 * Generated clips at `frame` whose render is not ready (SPEC §6.5): one slate
 * each, bottom layer first, with the render's state and live progress. Ready
 * renders need none: the engine composites them with the other layers. The
 * `live` clip plays its composition live (ADR 0010): its slate shrinks to a
 * label in the top right corner, away from the lower third where titles sit,
 * so nobody mistakes the live page for the render.
 */
export function RenderSlates({ program, frame, live = null }: { program: Program; frame: number; live?: string | null }) {
  const waiting = program.layers.flatMap((_, layer) => {
    const span = programAt(program, frame, layer);
    return span?.kind === "generated" && span.render?.state !== "ready" ? [span] : [];
  });
  const shown = waiting.find((span) => span.clip === live);
  const slates = waiting.filter((span) => span !== shown);
  return (
    <>
      {slates.length > 0 && (
        <div className="preview-render-slates">
          {slates.map((span) => (
            <Slate key={span.clip} span={span} />
          ))}
        </div>
      )}
      {shown && <LiveLabel span={shown} />}
    </>
  );
}

function Slate({ span }: { span: GeneratedSpan }) {
  const render = span.render && span.render.state !== "ready" ? span.render : null;
  const state = render?.state ?? "queued";
  const progress = render?.progress ?? 0;
  const title =
    state === "failed"
      ? t.preview.renderFailed
      : state === "unavailable"
        ? t.preview.cannotRender
        : state === "rendering"
          ? t.preview.rendering
          : t.preview.waitingRender;
  return (
    <div className="preview-layer-pending" data-testid="preview-layer-pending" data-clip={span.clip} data-state={state} role="status">
      <p className="preview-layer-title">
        {rich(title, { type: <code>{span.type}</code>, clip: <code>{span.clip}</code> })}
      </p>
      {(state === "rendering" || state === "queued") && (
        <div className="preview-layer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {render?.error && (
        <p className="preview-layer-error" title={render.error}>
          {render.error}
        </p>
      )}
    </div>
  );
}

/** Corner label of a clip shown live: what it is and how far its render got. */
function LiveLabel({ span }: { span: GeneratedSpan }) {
  const render = span.render && span.render.state !== "ready" ? span.render : null;
  const percent = Math.round((render?.progress ?? 0) * 100);
  const doing = render?.state === "rendering" ? t.preview.liveDoingRendering(percent) : t.preview.liveDoingWaiting;
  return (
    <p className="preview-live-label" data-testid="preview-live-label" data-clip={span.clip} role="status" title={t.preview.liveLabelHint(span.type, span.clip)}>
      {t.preview.liveLabel(doing)}
    </p>
  );
}
