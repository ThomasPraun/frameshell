import { type Program, type VideoSpan, programAt } from "../preview/program.js";

type GeneratedSpan = Extract<VideoSpan, { kind: "generated" }>;

/**
 * Generated clips at `frame` whose render is not ready (SPEC §6.5): one slate
 * each, bottom layer first, with the render's state and live progress. Ready
 * renders need none: the engine composites them with the other layers. The
 * `live` clip plays its composition live (ADR 0010): its slate shrinks to a
 * corner label, so nobody mistakes the live page for the render.
 */
export function RenderSlates({ program, frame, live = null }: { program: Program; frame: number; live?: string | null }) {
  const waiting = program.layers.flatMap((_, layer) => {
    const span = programAt(program, frame, layer);
    return span?.kind === "generated" && span.render?.state !== "ready" ? [span] : [];
  });
  if (waiting.length === 0) return null;
  return (
    <div className="preview-render-slates">
      {waiting.map((span) => (span.clip === live ? <LiveLabel key={span.clip} span={span} /> : <Slate key={span.clip} span={span} />))}
    </div>
  );
}

function Slate({ span }: { span: GeneratedSpan }) {
  const render = span.render && span.render.state !== "ready" ? span.render : null;
  const state = render?.state ?? "queued";
  const progress = render?.progress ?? 0;
  const title =
    state === "failed" ? "Render failed" : state === "unavailable" ? "Cannot render this clip" : state === "rendering" ? "Rendering" : "Waiting to render";
  return (
    <div className="preview-layer-pending" data-testid="preview-layer-pending" data-clip={span.clip} data-state={state} role="status">
      <p className="preview-layer-title">
        {title} <code>{span.type}</code> clip <code>{span.clip}</code>
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
  const doing = render?.state === "rendering" ? `rendering ${percent}%` : "waiting to render";
  return (
    <p className="preview-live-label" data-testid="preview-live-label" data-clip={span.clip} role="status" title={`Live preview of ${span.type} clip ${span.clip}: export uses the render`}>
      Live, {doing}
    </p>
  );
}
